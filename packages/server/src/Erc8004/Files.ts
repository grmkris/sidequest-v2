import { settledStages } from '@sidequest/fold'
import type { NostrEvent } from '@sidequest/nostr'
import { sidequestKinds } from '@sidequest/nostr/vocabulary'
import {
  AccountRef,
  type SidequestFeedbackFile,
  type SidequestRegistrationFile,
  type Unavailable,
} from '@sidequest/protocol'
import { stored } from '@sidequest/serving/Stored'
import { Effect, Option, Predicate, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'
import { ChainFacts } from '../Index/ChainFacts.ts'
import { EventStore } from '../Index/EventStore.ts'
import { nowSeconds } from '../Index/Ingest.ts'
import { Jobs } from '../Index/Jobs.ts'
import { Settlement } from '../Settlement/Settlement.ts'
import { feedbackFileOf, type JobEvidence } from './Feedback.ts'
import { Erc8004Identities } from './Identities.ts'
import { operatorOf, registrationFileOf, registrationsOf } from './Registration.ts'

/**
 * What one feedback file looks through, however much was signed about the key: the jobs of its newest `reviews`
 * reviews about it and its newest `proposals` proposals the chain funded, at most `jobs` jobs, newest first. Each job
 * is folded as `GET /api/index/jobs/:id` folds it.
 */
export const feedbackLimits = { reviews: 100, proposals: 100, jobs: 25 } as const

const JobRow = Schema.Struct({ job: Schema.String })

/** The jobs a key's feedback may come from: reviews naming it, and proposals of its that the chain funded. */
const candidateJobs = (sql: SqlClient.SqlClient) =>
  SqlSchema.findAll({
    Request: Schema.String,
    Result: JobRow,
    execute: (key) => sql`
      SELECT job FROM (
        SELECT * FROM (
          SELECT json_extract(e.content, '$.job') AS job, e.created_at AS at FROM events AS e
          WHERE e.id IN (SELECT event_id FROM event_tags WHERE name = 'p' AND value = ${key})
            AND e.kind = ${sidequestKinds.review}
          ORDER BY e.created_at DESC, e.id LIMIT ${feedbackLimits.reviews})
        UNION ALL
        SELECT * FROM (
          SELECT json_extract(p.content, '$.job') AS job, p.created_at AS at FROM events AS p
          WHERE p.pubkey = ${key} AND p.kind = ${sidequestKinds.proposal} AND EXISTS (
            SELECT 1 FROM chain_facts AS f WHERE f.job = json_extract(p.content, '$.job') AND f.kind = 'Funded'
              AND json_extract(f.fact, '$.termsDigest') = json_extract(p.content, '$.termsDigest'))
          ORDER BY p.created_at DESC, p.id LIMIT ${feedbackLimits.proposals})
      )
      WHERE job IS NOT NULL
      GROUP BY job ORDER BY MAX(at) DESC, job LIMIT ${feedbackLimits.jobs}`,
  })

/** The network a CAIP-10 account is on: everything before its last colon. */
const networkOf = (account: string) => account.slice(0, account.lastIndexOf(':'))

/** A job's fold with the events and transactions its counted reviews cite; `None` unless the operator settled it. */
const jobEvidenceOf =
  (events: EventStore['Service'], jobs: Jobs['Service'], facts: ChainFacts['Service']) =>
  (job: string): Effect.Effect<Option.Option<JobEvidence>, Unavailable> =>
    Effect.gen(function* () {
      const view = yield* jobs.job(job)
      if (Option.isNone(view) || !settledStages.has(view.value.stage)) return Option.none<JobEvidence>()
      const { funding, ending } = view.value
      // Only the operator's own settlement is a log a reader can check against the operator; a reclaim from the escrow
      // after expiry is left out.
      if (funding === null || ending === null || !Predicate.isTagged(ending, 'Settled')) return Option.none()
      const network = networkOf(funding.fact.payer)
      const fundingTx = yield* facts.transactionAt(network, funding.fact.at)
      const settlementTx = yield* facts.transactionAt(network, ending.at)
      const accounts = [funding.fact.payer, funding.fact.receiver].map((account) => account.toLowerCase())
      const links = yield* Effect.forEach(accounts, (account) =>
        Effect.map(events.wallet(account), (link) =>
          Option.map(link, (row): [string, string] => [account, row.eventId]),
        ),
      )
      const linkOf = new Map(links.flatMap(Option.toArray))
      const funded = view.value.proposals.find((proposal) => proposal.id === funding.proposal)
      const ids = [
        ...view.value.reviews.filter((review) => review.status === 'counted').map((review) => review.id),
        ...linkOf.values(),
        ...(funded === undefined ? [] : [funded.id, ...(funded.grant === null ? [] : [funded.grant])]),
      ]
      const found = yield* Effect.forEach([...new Set(ids)], (id) => events.find(id))
      const cited = new Map(found.flatMap(Option.toArray).map((event): [string, NostrEvent] => [event.id, event]))
      return Option.map(Option.all({ fundingTx, settlementTx }), (transactions) => ({
        view: view.value,
        events: cited,
        linkOf,
        ...transactions,
      }))
    })

/**
 * The index's ERC-8004 files: a key's registration file and its feedback file, as served at `origin`. Needs the index
 * (`EventStore`, `Jobs`, `ChainFacts`, `Erc8004Identities`), `Settlement` and the database's `SqlClient`.
 */
export const makeErc8004Files = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const events = yield* EventStore
  const jobs = yield* Jobs
  const facts = yield* ChainFacts
  const identities = yield* Erc8004Identities
  const settlement = yield* Settlement
  const candidates = candidateJobs(sql)

  const evidenceOf = jobEvidenceOf(events, jobs, facts)

  const registrationsFor = (pubkey: string) => Effect.map(identities.of(pubkey), registrationsOf)

  /** The key's feedback file; with no settlement chain on the stage, it has no entries. */
  const feedback = (pubkey: string, origin: string): Effect.Effect<SidequestFeedbackFile, Unavailable> =>
    Effect.gen(function* () {
      const registrations = yield* registrationsFor(pubkey)
      const operator = Option.map(settlement, ({ chain }) =>
        AccountRef.make(`eip155:${chain.chainId}:${chain.operator}`),
      )
      if (Option.isNone(operator)) return { subject: pubkey, registrations, count: 0, averageRating: null, items: [] }
      const found = yield* stored(candidates(pubkey))
      const evidence = yield* Effect.forEach(found, ({ job }) => evidenceOf(job))
      return feedbackFileOf(
        { subject: pubkey, operator: operator.value, registrations, origin },
        evidence.flatMap(Option.toArray),
      )
    }).pipe(Effect.withSpan('Sidequest.Erc8004.feedback'))

  /** The key's registration file; `None` when the index knows nothing of the key. */
  const registration = (
    pubkey: string,
    origin: string,
  ): Effect.Effect<Option.Option<SidequestRegistrationFile>, Unavailable> =>
    Effect.gen(function* () {
      const known = yield* events.known(pubkey)
      const claims = yield* identities.of(pubkey)
      const nothing =
        claims.length === 0 &&
        Option.isNone(known.profile) &&
        known.wallets.length === 0 &&
        known.operators.length === 0
      if (nothing) return Option.none()
      const operator = Option.filter(operatorOf(known, claims), (key) => key !== pubkey)
      const operating = yield* Option.match(operator, {
        onNone: () => Effect.succeed(Option.none()),
        onSome: (key) =>
          Effect.map(events.known(key), (operatorKnown) =>
            Option.map(Option.fromUndefinedOr(known.operators.find((grant) => grant.operator === key)), (grant) => ({
              grant,
              wallets: operatorKnown.wallets,
            })),
          ),
      })
      return Option.some(
        registrationFileOf({ pubkey, origin, known, identities: claims, operating, now: yield* nowSeconds }),
      )
    }).pipe(Effect.withSpan('Sidequest.Erc8004.registration'))

  return { feedback, registration }
})
