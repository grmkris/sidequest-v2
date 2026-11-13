import type { JobEvent } from '@sidequest/fold'
import type { NostrEvent } from '@sidequest/nostr'
import {
  deliveryNote,
  envelopeTag,
  jobAccept,
  jobProposal,
  jobRequest,
  jobReview,
  type KindSpec,
  type ParsedEvent,
  parseSidequestEvent,
  sidequestKinds,
  statement,
} from '@sidequest/nostr/vocabulary'
import { Effect, Option, Schema } from 'effect'
import type * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'
import { EventRow } from './EventStore.ts'

/**
 * The most events of each kind one job read folds, newest first (`created_at`, then id), so a job with thousands of
 * spam proposals costs the same as one with fifty: every event is verified again as it is read (about a millisecond
 * each), so a read verifies at most about 150. Besides these, a read always folds the events that decide the job's
 * stage whatever the spam: the buyer's newest accepts and the proposals they name, the buyer's withdrawal of the
 * request, and proposals whose terms digest the chain funded. The buyer's accepts and withdrawal include those their
 * agents signed naming a grant the buyer gave; whether that grant authorises them is the fold's to judge.
 */
export const jobReadLimits = {
  proposals: 50,
  accepts: 20,
  deliveryNotes: 10,
  statements: 30,
  reviews: 20,
  buyerAccepts: 10,
  buyerWithdrawals: 10,
  fundedProposals: 5,
} as const

type Reader = (event: NostrEvent) => Effect.Effect<Option.Option<JobEvent>>

const reading =
  <C>(spec: KindSpec<C>, wrap: (parsed: ParsedEvent<C>) => JobEvent): Reader =>
  (event) =>
    parseSidequestEvent(spec, event).pipe(Effect.map(wrap), Effect.option)

/** Each job kind's reader into the fold's `JobEvent`; a stored event always reads again, one that would not is left out. */
const readers: ReadonlyMap<number, Reader> = new Map<number, Reader>([
  [sidequestKinds.request, reading(jobRequest, (parsed) => ({ type: 'request', parsed }))],
  [sidequestKinds.proposal, reading(jobProposal, (parsed) => ({ type: 'proposal', parsed }))],
  [sidequestKinds.accept, reading(jobAccept, (parsed) => ({ type: 'accept', parsed }))],
  [sidequestKinds.deliveryNote, reading(deliveryNote, (parsed) => ({ type: 'deliveryNote', parsed }))],
  [sidequestKinds.statement, reading(statement, (parsed) => ({ type: 'statement', parsed }))],
  [sidequestKinds.review, reading(jobReview, (parsed) => ({ type: 'review', parsed }))],
])

/** Stored events as the fold's job events, each verified and read by its kind's reader. */
export const jobEventsOf = (events: ReadonlyArray<NostrEvent>) =>
  Effect.map(
    Effect.forEach(events, (event) => readers.get(event.kind)?.(event) ?? Effect.succeedNone),
    (read) => read.flatMap(Option.toArray),
  )

const ByJob = Schema.Struct({ job: Schema.String, kind: Schema.Int, limit: Schema.Int })

/**
 * The queries a job read makes, each bounded by its `LIMIT`. An event about a job carries the job's id as an `e` tag
 * (the vocabulary implies it), so each starts from the `event_tags` index, and its content's `job` must be the job,
 * as the fold requires: an `e` tag alone may name the job as something else (a statement's `about`).
 */
export const jobQueries = (sql: SqlClient.SqlClient) => {
  // `+kind` keeps SQLite from answering by the kind index (every event of the kind) when it has no statistics, as a
  // fresh D1 database has none: the few ids the `e` tag names are looked up by id instead (migration 0015's notes).
  const about = (job: string, kind: number) => sql`
    id IN (SELECT event_id FROM event_tags WHERE name = 'e' AND value = ${job})
    AND +kind = ${kind} AND json_extract(content, '$.job') = ${job}`
  const columns = sql`id, pubkey, created_at, kind, tags, content, sig`
  const newest = SqlSchema.findAll({
    Request: ByJob,
    Result: EventRow,
    execute: ({ job, kind, limit }) => sql`
      SELECT ${columns} FROM events WHERE ${about(job, kind)} ORDER BY created_at DESC, id LIMIT ${limit}`,
  })
  // Signed by the buyer, or by a key naming a grant the buyer gave.
  const byBuyer = (buyer: string) => sql`(pubkey = ${buyer} OR id IN (
    SELECT t.event_id FROM event_tags AS t JOIN agent_grants AS g ON g.event_id = t.value
    WHERE t.name = ${envelopeTag.grant} AND g.operator = ${buyer}))`
  const buyerAccepts = SqlSchema.findAll({
    Request: Schema.Struct({ job: Schema.String, buyer: Schema.String }),
    Result: EventRow,
    execute: ({ job, buyer }) => sql`
      SELECT ${columns} FROM events WHERE ${about(job, sidequestKinds.accept)} AND ${byBuyer(buyer)}
      ORDER BY created_at DESC, id LIMIT ${jobReadLimits.buyerAccepts}`,
  })
  // The buyer's withdrawal of the request: the fold's `closedByBuyer`, for the buyer's own key or an agent's.
  const withdrawal = SqlSchema.findAll({
    Request: Schema.Struct({ job: Schema.String, buyer: Schema.String }),
    Result: EventRow,
    execute: ({ job, buyer }) => sql`
      SELECT ${columns} FROM events WHERE ${about(job, sidequestKinds.statement)} AND ${byBuyer(buyer)}
        AND json_extract(content, '$.type') = 'withdraw_request'
        AND (json_extract(content, '$.about') IS NULL OR json_extract(content, '$.about') = ${job})
      ORDER BY created_at DESC, id LIMIT ${jobReadLimits.buyerWithdrawals}`,
  })
  const proposalsNamed = SqlSchema.findAll({
    Request: Schema.Struct({ job: Schema.String, ids: Schema.Array(Schema.String) }),
    Result: EventRow,
    execute: ({ job, ids }) => sql`
      SELECT ${columns} FROM events WHERE ${about(job, sidequestKinds.proposal)} AND ${sql.in('id', ids)}`,
  })
  const proposalsFunded = SqlSchema.findAll({
    Request: Schema.Struct({ job: Schema.String, termsDigest: Schema.String }),
    Result: EventRow,
    execute: ({ job, termsDigest }) => sql`
      SELECT ${columns} FROM events WHERE ${about(job, sidequestKinds.proposal)}
        AND json_extract(content, '$.termsDigest') = ${termsDigest}
      ORDER BY created_at DESC, id LIMIT ${jobReadLimits.fundedProposals}`,
  })
  return { newest, buyerAccepts, withdrawal, proposalsNamed, proposalsFunded }
}
