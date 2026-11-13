import { type ChainFact, type ChainFunded, foldJob, type JobView, type WalletLinkFact } from '@sidequest/fold'
import { OpenJob } from '@sidequest/fold/api'
import { PublicKey } from '@sidequest/nostr'
import { EvmAccount, JobRequestContent, sidequestKinds } from '@sidequest/nostr/vocabulary'
import { type BadCursor, type Cursor, defaultPageSize, type Unavailable } from '@sidequest/protocol'
import { Context, Effect, Layer, Option, Predicate, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'
import { cursors, type PageRequest } from '../Reads/Pages.ts'
import { stored } from '../SignIn/Stored.ts'
import { ChainFacts } from './ChainFacts.ts'
import { EventStore } from './EventStore.ts'
import { nowSeconds } from './Ingest.ts'
import { jobEventsOf, jobQueries, jobReadLimits } from './JobEvents.ts'

// An open request is `OpenJob` (`@sidequest/fold/api`); its `proposals` count stops at `openJobLimits.proposalCount`.

/**
 * What bounds a page of open requests: it examines at most `scan` requests, newest first, and counts at most
 * `proposalCount` proposals for each, so a page costs the same however many requests are funded or closed. A page
 * may therefore hold fewer items than asked, or none, and still have a next page.
 */
export const openJobLimits = { scan: 100, proposalCount: 100 } as const

/** A page of open requests: newest first, and whether to leave out the expired ones. */
export interface OpenJobsQuery extends PageRequest {
  readonly hideExpired: boolean
}

const Position = Schema.Struct({ createdAt: Schema.Int, id: Schema.String })
const openCursors = cursors(Position)

const Candidate = Schema.Struct({
  id: Schema.String,
  pubkey: Schema.String,
  createdAt: Schema.Int,
  content: Schema.String,
  funded: Schema.Literals([0, 1]),
  closed: Schema.Literals([0, 1]),
  proposals: Schema.Int,
})
type Candidate = typeof Candidate.Type

/**
 * The newest `openJobLimits.scan` requests after the cursor, each with whether the chain funded it, whether its buyer
 * closed it, and its proposals counted up to the cap. Each flag is an index lookup (`chain_facts_by_job`,
 * `event_tags_by_value`), the same rules the fold applies.
 */
const candidates = (sql: SqlClient.SqlClient) =>
  SqlSchema.findAll({
    Request: Schema.Struct({ after: Schema.NullOr(Position) }),
    Result: Candidate,
    execute: ({ after }) => sql`
      WITH page AS (
        SELECT id FROM events
        WHERE kind = ${sidequestKinds.request}
          AND (${after?.createdAt ?? null} IS NULL OR created_at < ${after?.createdAt ?? null}
            OR (created_at = ${after?.createdAt ?? null} AND id > ${after?.id ?? null}))
        ORDER BY created_at DESC, id LIMIT ${openJobLimits.scan}
      ), flagged AS (
        SELECT r.id, r.pubkey, r.created_at, r.content,
          EXISTS (SELECT 1 FROM chain_facts AS f WHERE f.job = r.id AND f.kind = 'Funded') AS funded,
          EXISTS (
            SELECT 1 FROM events AS s
            WHERE s.id IN (SELECT event_id FROM event_tags WHERE name = 'e' AND value = r.id)
              AND s.kind = ${sidequestKinds.statement} AND s.pubkey = r.pubkey
              AND json_extract(s.content, '$.job') = r.id
              AND json_extract(s.content, '$.type') = 'withdraw_request'
              AND (json_extract(s.content, '$.about') IS NULL OR json_extract(s.content, '$.about') = r.id)
          ) AS closed
        FROM page JOIN events AS r ON r.id = page.id
      )
      SELECT id, pubkey, created_at AS createdAt, content, funded, closed,
        CASE WHEN funded = 1 OR closed = 1 THEN 0 ELSE (
          SELECT COUNT(*) FROM (
            SELECT 1 FROM events AS p
            WHERE p.id IN (SELECT event_id FROM event_tags WHERE name = 'e' AND value = flagged.id)
              AND p.kind = ${sidequestKinds.proposal} AND json_extract(p.content, '$.job') = flagged.id
            LIMIT ${openJobLimits.proposalCount})
        ) END AS proposals
      FROM flagged ORDER BY created_at DESC, id`,
  })

const RequestJson = Schema.fromJsonString(JobRequestContent)
const AcceptedProposal = Schema.fromJsonString(Schema.Struct({ proposal: Schema.String }))

/** The earliest funding of the job, which `forJob` answers first: the one the fold uses. */
const fundingOf = (chain: ReadonlyArray<ChainFact>) =>
  chain.find((fact): fact is ChainFunded => Predicate.isTagged(fact, 'Funded'))

const openJobOf = (candidate: Candidate, now: number): Option.Option<OpenJob> =>
  Option.flatMap(Schema.decodeUnknownOption(RequestJson)(candidate.content), (request) =>
    Schema.decodeUnknownOption(OpenJob)({
      job: candidate.id,
      buyer: candidate.pubkey,
      createdAt: candidate.createdAt,
      request,
      expired: now >= request.expiresAt,
      proposals: candidate.proposals,
    }),
  )

/** The wallet links the fold reads: the current verified holders of the funding's payer and receiver wallets. */
const linksOf = (events: EventStore['Service'], chain: ReadonlyArray<ChainFact>) =>
  Effect.gen(function* () {
    const funding = fundingOf(chain)
    if (funding === undefined) return []
    const wallets = [funding.payer, funding.receiver].map((account) => account.toLowerCase())
    const held = yield* Effect.forEach(wallets, (wallet) =>
      Effect.map(events.wallet(wallet), (link) =>
        Option.flatMap(link, ({ account, pubkey }) =>
          Option.map(
            Option.all({
              wallet: Schema.decodeUnknownOption(EvmAccount)(account),
              pubkey: Schema.decodeUnknownOption(PublicKey)(pubkey),
            }),
            (fact): WalletLinkFact => fact,
          ),
        ),
      ),
    )
    return held.flatMap(Option.toArray)
  })

/** The index's jobs: one folded from its events and the chain's facts, and the open requests. */
export class Jobs extends Context.Service<
  Jobs,
  {
    /** The job whose request event is `id`, folded; `None` when that request is not indexed. */
    readonly job: (id: string) => Effect.Effect<Option.Option<JobView>, Unavailable>
    readonly open: (
      query: OpenJobsQuery,
    ) => Effect.Effect<
      { readonly items: ReadonlyArray<OpenJob>; readonly next: Cursor | null },
      BadCursor | Unavailable
    >
  }
>()('Sidequest/Index/Jobs') {
  /** Over the D1 tables; needs the database's `SqlClient`, the `EventStore` and `ChainFacts`. */
  static readonly layer = Layer.effect(
    Jobs,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const events = yield* EventStore
      const facts = yield* ChainFacts
      const query = jobQueries(sql)
      const scan = candidates(sql)

      /** The job's events, bounded per kind (`jobReadLimits`), with those that decide its stage always included. */
      const eventsOf = (job: string, buyer: string, chain: ReadonlyArray<ChainFact>) =>
        Effect.gen(function* () {
          const newest = (kind: number, limit: number) => stored(query.newest({ job, kind, limit }))
          const proposals = yield* newest(sidequestKinds.proposal, jobReadLimits.proposals)
          const accepts = yield* newest(sidequestKinds.accept, jobReadLimits.accepts)
          const notes = yield* newest(sidequestKinds.deliveryNote, jobReadLimits.deliveryNotes)
          const statements = yield* newest(sidequestKinds.statement, jobReadLimits.statements)
          const reviews = yield* newest(sidequestKinds.review, jobReadLimits.reviews)
          const buyerAccepts = yield* stored(query.buyerAccepts({ job, buyer }))
          const withdrawal = yield* stored(query.withdrawal({ job, buyer }))
          const named = buyerAccepts.flatMap((accept) =>
            Option.toArray(Option.map(Schema.decodeUnknownOption(AcceptedProposal)(accept.content), (c) => c.proposal)),
          )
          const accepted = named.length === 0 ? [] : yield* stored(query.proposalsNamed({ job, ids: named }))
          const funding = fundingOf(chain)
          const funded =
            funding === undefined ? [] : yield* stored(query.proposalsFunded({ job, termsDigest: funding.termsDigest }))
          // The fold drops duplicates by id, so the always-included events may repeat the newest.
          return [
            ...proposals,
            ...accepts,
            ...notes,
            ...statements,
            ...reviews,
            ...buyerAccepts,
            ...withdrawal,
            ...accepted,
            ...funded,
          ]
        })

      const job = Effect.fn('Sidequest.Index.job')(function* (id: string) {
        const request = yield* events.find(id)
        if (Option.isNone(request) || request.value.kind !== sidequestKinds.request) return Option.none()
        const chain = yield* facts.forJob(id)
        const about = yield* eventsOf(id, request.value.pubkey, chain)
        const read = yield* jobEventsOf([request.value, ...about])
        const walletLinks = yield* linksOf(events, chain)
        return foldJob({ job: request.value.id, events: read, chain, walletLinks, now: yield* nowSeconds })
      })

      const open = Effect.fn('Sidequest.Index.openJobs')(function* (request: OpenJobsQuery) {
        const after = yield* openCursors.decode(request.cursor)
        const rows = yield* stored(scan({ after: after ?? null }))
        const now = yield* nowSeconds
        const limit = request.limit ?? defaultPageSize
        const listed = rows
          .filter((row) => row.funded === 0 && row.closed === 0)
          .flatMap((row) => Option.toArray(Option.map(openJobOf(row, now), (item) => ({ row, item }))))
          .filter(({ item }) => !request.hideExpired || !item.expired)
        const items = listed.slice(0, limit)
        // Past the page's last item when more open requests follow it in this scan; past the scan when it was full.
        const scanFull = rows.length === openJobLimits.scan ? rows.at(-1) : undefined
        const last = listed.length > limit ? items.at(-1)?.row : scanFull
        const next = last === undefined ? null : yield* openCursors.encode({ createdAt: last.createdAt, id: last.id })
        return { items: items.map(({ item }) => item), next }
      })

      return Jobs.of({ job, open })
    }),
  )
}
