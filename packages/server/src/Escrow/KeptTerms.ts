import type { NostrEvent } from '@sidequest/nostr'
import { sidequestKinds } from '@sidequest/nostr/vocabulary'
import type { Unavailable } from '@sidequest/protocol'
import { Effect, Option, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'
import { EventRow } from '../Index/EventStore.ts'
import { stored } from '@sidequest/serving/Stored'

/** The most proposals kept for one job that a read returns; several match only when terms and payee repeat. */
const keptProposalLimit = 5

const KeptRow = Schema.Struct({ ...EventRow.fields, role: Schema.Literals(['request', 'proposal']) })

/** A kept row as the event it is, field for field. */
const verbatim = ({ id, pubkey, created_at, kind, tags, content, sig }: typeof KeptRow.Type): NostrEvent => ({
  id,
  pubkey,
  created_at,
  kind,
  tags,
  content,
  sig,
})

/**
 * The signed terms of funded jobs, kept for good (`kept_events`; ADR-0003, decision 2): the chain holds only their
 * digest. `keep` marks, in one idempotent statement, the request of every job the chain funded and every proposal the
 * chain could have funded (its job, terms digest and `payTo` are the funding's job, terms digest and receiver: the
 * fold's candidates, so the one it picks is always among them). A request or proposal indexed after its funding is
 * marked by the next `keep`. Nothing prunes `events` today; any pruning must spare what is marked.
 */
export const keptTerms = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const read = SqlSchema.findAll({
    Request: Schema.String,
    Result: KeptRow,
    execute: (job) => sql`
      SELECT e.id, e.pubkey, e.created_at, e.kind, e.tags, e.content, e.sig, k.role FROM kept_events AS k
      JOIN events AS e ON e.id = k.event_id WHERE k.job = ${job}
      ORDER BY k.role DESC, e.id LIMIT ${keptProposalLimit + 1}`,
  })
  return {
    keep: stored(sql`
      INSERT INTO kept_events (event_id, job, role)
      SELECT r.id, r.id, 'request' FROM chain_facts AS f
      JOIN events AS r ON r.id = f.job AND r.kind = ${sidequestKinds.request}
      WHERE f.kind = 'Funded'
      UNION ALL
      SELECT p.id, f.job, 'proposal' FROM chain_facts AS f
      JOIN event_tags AS t ON t.name = 'e' AND t.value = f.job
      JOIN events AS p ON p.id = t.event_id AND p.kind = ${sidequestKinds.proposal}
      WHERE f.kind = 'Funded' AND json_extract(p.content, '$.job') = f.job
        AND json_extract(p.content, '$.termsDigest') = json_extract(f.fact, '$.termsDigest')
        AND lower(json_extract(p.content, '$.payTo')) = lower(json_extract(f.fact, '$.receiver'))
      ON CONFLICT (event_id) DO NOTHING`).pipe(Effect.asVoid, Effect.withSpan('Sidequest.Escrow.keepTerms')),
    /**
     * The kept request of `job` and its kept proposal: `preferred` (the fold's funded proposal) when it is kept, else
     * the lowest id. `None` until the job is funded and marked.
     */
    terms: Effect.fn('Sidequest.Escrow.keptTerms')(function* (
      job: string,
      preferred: string | null,
    ): Effect.fn.Return<Option.Option<{ request: NostrEvent; proposal: NostrEvent }>, Unavailable> {
      const rows = yield* stored(read(job))
      const request = rows.find(({ role }) => role === 'request')
      const proposals = rows.filter(({ role }) => role === 'proposal')
      const proposal = proposals.find(({ id }) => id === preferred) ?? proposals[0]
      if (request === undefined || proposal === undefined) return Option.none()
      return Option.some({ request: verbatim(request), proposal: verbatim(proposal) })
    }),
  }
})
