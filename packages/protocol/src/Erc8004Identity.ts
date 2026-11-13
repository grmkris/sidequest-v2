import { Effect, Schema } from 'effect'
import { AccountRef } from './AccountRef.ts'
import { Hex32 } from './Hex32.ts'

/**
 * Why a claim is not verified at the index's latest read of its token: no such token, its owner is no wallet linked
 * to the claim's author, the subject is neither the author nor an agent they granted (unrevoked), or its `agentURI`
 * is not the subject's registration file.
 */
export const Erc8004Failure = Schema.Literals(['noToken', 'ownerNotLinked', 'notGranted', 'otherUri'])
export type Erc8004Failure = typeof Erc8004Failure.Type

/**
 * One claim that an ERC-8004 identity stands for a key (ADR-0007, decision 5), as of the index's latest read of its
 * token: `verified`, `unverified` with the first rule it fails, or `unchecked` until the chain has been read.
 */
export const Erc8004Identity = Schema.Struct({
  registry: AccountRef,
  agentId: Schema.String,
  claim: Hex32,
  claimedBy: Hex32,
  mcp: Schema.NullOr(Schema.String),
  status: Schema.Literals(['verified', 'unverified', 'unchecked']),
  failure: Schema.NullOr(Erc8004Failure),
  readAtBlock: Schema.NullOr(Schema.Int),
})
export type Erc8004Identity = typeof Erc8004Identity.Type

/** A key's ERC-8004 identities, defaulting to none, so a person served before identities existed still reads. */
export const Erc8004Identities = Schema.Array(Erc8004Identity).pipe(Schema.withDecodingDefaultKey(Effect.succeed([])))
