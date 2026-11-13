import { AccountRef, type Erc8004Failure, type Erc8004Identity, Hex32, type Unavailable } from '@sidequest/protocol'
import { stored } from '@sidequest/serving/Stored'
import { Context, Effect, Layer, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'

// The index's ERC-8004 identities (ADR-0007, decision 5): claims, one row per event, and the latest read of each
// claimed token. Whether a claim is verified is decided here, at the read, from facts that never depend on the order
// they arrived in: the claim, the token's latest read, the author's winning verified wallet links and the author's
// unrevoked grants. So the same events and the same chain reads answer the same, in any order and after a rebuild.

/** Where a key's registration file is served, on whatever origin: the path an `agentURI` must have. */
export const registrationPath = (pubkey: string) => `/api/erc8004/agents/${pubkey}/registration`

/** Whether an `agentURI` is the subject's registration file: an http(s) URL whose path is exactly its path. */
export const namesRegistrationOf = (agentUri: string, subject: string): boolean => {
  if (!URL.canParse(agentUri)) return false
  const url = new URL(agentUri)
  return (url.protocol === 'https:' || url.protocol === 'http:') && url.pathname === registrationPath(subject)
}

/** What the read joins for one claim: the token's latest read, if any, and the two facts about its author. */
export interface ClaimFacts {
  readonly subject: string
  /** The block of the token's latest read; `null` before the chain has been read. */
  readonly block: number | null
  /** The token's owner (lowercase), `null` when there is no such token. */
  readonly owner: string | null
  readonly agentUri: string | null
  /** The owner's address is that of a wallet currently linked to the author by a verified link, on any EVM chain. */
  readonly ownerLinked: boolean
  /** The subject is the author, or the author gave the subject a grant they have not revoked. */
  readonly granted: boolean
}

const failing = (failure: Erc8004Failure) => ({ status: 'unverified' as const, failure })

/** A claim's status at the token's latest read, and the first rule it fails. Pure. */
export const claimStatus = (
  facts: ClaimFacts,
): { readonly status: Erc8004Identity['status']; readonly failure: Erc8004Failure | null } => {
  if (facts.block === null) return { status: 'unchecked', failure: null }
  if (facts.owner === null) return failing('noToken')
  if (!facts.ownerLinked) return failing('ownerNotLinked')
  if (!facts.granted) return failing('notGranted')
  if (!namesRegistrationOf(facts.agentUri ?? '', facts.subject)) return failing('otherUri')
  return { status: 'verified', failure: null }
}

/** A token to read: its registry (CAIP-10, lowercase) and id. */
export interface DueToken {
  readonly registry: string
  readonly agentId: string
}

/** One read of a token at `block`: its owner (lowercase), or `null` when there is no such token, and its URI. */
export interface TokenFact extends DueToken {
  readonly owner: string | null
  readonly agentUri: string
  readonly block: number
}

/** The most claims a key's read answers: more than anyone registers, bounded against a key named by thousands. */
export const identityLimits = { claimsPerKey: 20 } as const

const Flag = Schema.Literals([0, 1])
const ClaimRecord = Schema.Struct({
  claim: Hex32,
  claimedBy: Hex32,
  subject: Schema.String,
  registry: AccountRef,
  agentId: Schema.String,
  mcp: Schema.NullOr(Schema.String),
  block: Schema.NullOr(Schema.Int),
  owner: Schema.NullOr(Schema.String),
  agentUri: Schema.NullOr(Schema.String),
  ownerLinked: Flag,
  granted: Flag,
})
type ClaimRecord = typeof ClaimRecord.Type

/** The claim as the API shows it. */
const identityOf = (record: ClaimRecord): Erc8004Identity => ({
  registry: record.registry,
  agentId: record.agentId,
  claim: record.claim,
  claimedBy: record.claimedBy,
  mcp: record.mcp,
  ...claimStatus({ ...record, ownerLinked: record.ownerLinked === 1, granted: record.granted === 1 }),
  readAtBlock: record.block,
})

/** How near a claim is to verified: the rules in order, so of two claims on one token the nearer is shown. */
const nearness: Readonly<Record<string, number>> = {
  verified: 0,
  otherUri: 1,
  notGranted: 2,
  ownerNotLinked: 3,
  noToken: 4,
  unchecked: 5,
}
const rankOf = (identity: Erc8004Identity) => nearness[identity.failure ?? identity.status] ?? 6

/**
 * Of several claims on one token for a key, the one shown: the nearest to verified, and of those the first in the
 * query's order. A stranger's claim on someone else's token never hides the owner's.
 */
const onePerToken = (identities: ReadonlyArray<Erc8004Identity>): ReadonlyArray<Erc8004Identity> => {
  const shown = new Map<string, Erc8004Identity>()
  for (const identity of identities) {
    const token = `${identity.registry}/${identity.agentId}`
    const current = shown.get(token)
    if (current === undefined || rankOf(identity) < rankOf(current)) shown.set(token, identity)
  }
  return [...shown.values()]
}

const DueRecord = Schema.Struct({ registry: Schema.String, agentId: Schema.String })

export class Erc8004Identities extends Context.Service<
  Erc8004Identities,
  {
    /** The claims that a token stands for `subject`, one per token: an owner's granted claims first, then the newest. */
    readonly of: (subject: string) => Effect.Effect<ReadonlyArray<Erc8004Identity>, Unavailable>
    /** Claimed tokens on `registry` never read, or last read at or before `staleBefore`: oldest read first. */
    readonly due: (
      registry: string,
      staleBefore: number,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<DueToken>, Unavailable>
    /** Records a read at `readAt` (Unix seconds); a read from an earlier block than the one kept changes nothing. */
    readonly record: (fact: TokenFact, readAt: number) => Effect.Effect<void, Unavailable>
  }
>()('Sidequest/Erc8004/Identities') {
  /** Over the D1 tables; needs the database's `SqlClient`. */
  static readonly layer = Layer.effect(
    Erc8004Identities,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      // The author's current wallets, by the rule `wallet_links` reads everywhere: a verified link no other verified
      // link of its account beats. A CAIP-10 account's last 42 characters are its address.
      const ownerLinked = sql`
        EXISTS (
          SELECT 1 FROM wallet_links AS link
          WHERE link.pubkey = c.author AND link.verification = 'verified' AND substr(link.account, -42) = t.owner
            AND NOT EXISTS (
              SELECT 1 FROM wallet_links AS rival
              WHERE rival.account = link.account AND rival.verification = 'verified'
                AND (rival.issued_at > link.issued_at
                  OR (rival.issued_at = link.issued_at AND rival.event_id < link.event_id))))`
      // A grant is revoked by a revocation naming it that its own operator signed, whichever arrived first.
      const granted = sql`
        (c.subject = c.author OR EXISTS (
          SELECT 1 FROM agent_grants AS g WHERE g.operator = c.author AND g.agent = c.subject
            AND NOT EXISTS (
              SELECT 1 FROM grant_revocations AS r WHERE r.grant_id = g.event_id AND r.pubkey = g.operator)))`
      const claims = SqlSchema.findAll({
        Request: Schema.String,
        Result: ClaimRecord,
        execute: (subject) => sql`
          SELECT c.event_id AS claim, c.author AS claimedBy, c.subject, c.registry, c.agent_id AS agentId, c.mcp,
            t.block AS block, t.owner AS owner, t.agent_uri AS agentUri,
            CASE WHEN t.owner IS NULL THEN 0 ELSE ${ownerLinked} END AS ownerLinked, ${granted} AS granted
          FROM erc8004_claims AS c LEFT JOIN erc8004_tokens AS t ON t.registry = c.registry AND t.agent_id = c.agent_id
          WHERE c.subject = ${subject}
          -- Claims by a linked owner the subject granted come first, so others' claims about the key cannot crowd
          -- them out of the limit.
          ORDER BY (ownerLinked AND granted) DESC, c.created_at DESC, c.event_id LIMIT ${identityLimits.claimsPerKey}`,
      })
      const due = SqlSchema.findAll({
        Request: Schema.Struct({ registry: Schema.String, staleBefore: Schema.Int, limit: Schema.Int }),
        Result: DueRecord,
        execute: ({ registry, staleBefore, limit }) => sql`
          SELECT c.registry AS registry, c.agent_id AS agentId
          FROM erc8004_claims AS c LEFT JOIN erc8004_tokens AS t ON t.registry = c.registry AND t.agent_id = c.agent_id
          WHERE c.registry = ${registry} AND (t.read_at IS NULL OR t.read_at <= ${staleBefore})
          GROUP BY c.registry, c.agent_id
          ORDER BY COALESCE(MAX(t.read_at), -1), c.agent_id LIMIT ${limit}`,
      })
      return Erc8004Identities.of({
        of: (subject) =>
          stored(claims(subject)).pipe(
            Effect.map((records) => onePerToken(records.map(identityOf))),
            Effect.withSpan('Sidequest.Erc8004.identities'),
          ),
        due: (registry, staleBefore, limit) =>
          stored(due({ registry, staleBefore, limit })).pipe(Effect.withSpan('Sidequest.Erc8004.due')),
        record: (fact, readAt) =>
          stored(sql`
            INSERT INTO erc8004_tokens (registry, agent_id, owner, agent_uri, block, read_at)
            VALUES (${fact.registry}, ${fact.agentId}, ${fact.owner}, ${fact.agentUri}, ${fact.block}, ${readAt})
            ON CONFLICT (registry, agent_id) DO UPDATE SET owner = excluded.owner, agent_uri = excluded.agent_uri,
              block = excluded.block, read_at = excluded.read_at
            WHERE excluded.block >= erc8004_tokens.block`).pipe(
            Effect.asVoid,
            Effect.withSpan('Sidequest.Erc8004.recordToken'),
          ),
      })
    }),
  )
}
