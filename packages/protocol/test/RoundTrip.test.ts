import { it } from '@effect/vitest'
import { Schema } from 'effect'
import { describe, expect, test } from 'vitest'
import { Account } from '../src/Account.ts'
import { AccountRef } from '../src/AccountRef.ts'
import { Actor } from '../src/Actor.ts'
import { Agent } from '../src/Agent.ts'
import { Agreement } from '../src/Agreement.ts'
import { Amount } from '../src/Amount.ts'
import { AssetId, AssetRef } from '../src/AssetRef.ts'
import { UsdcOnArcTestnet } from '../src/AssetRegistry.ts'
import { Delivery } from '../src/Delivery.ts'
import { Digest } from '../src/Digest.ts'
import { Grant } from '../src/Grant.ts'
import { AccountId, AgentId, JobId, ListingId, ProposalId, RoomId } from '../src/Id.ts'
import { JobState } from '../src/JobState.ts'
import { Listing } from '../src/Listing.ts'
import { NetworkRef } from '../src/NetworkRef.ts'
import { PaymentIntent } from '../src/PaymentIntent.ts'
import { Proposal } from '../src/Proposal.ts'
import { Receipt } from '../src/Receipt.ts'
import { Review } from '../src/Review.ts'
import { Terms } from '../src/Terms.ts'
import { WorkRequest } from '../src/WorkRequest.ts'
import { accountId, digest, encodedTerms, jobId, otherAccountId, proposalId } from './fixtures.ts'

// Generated objects may lack Object.prototype, so compare by the schema's own equivalence.
const roundTrips = <S extends Schema.Codec<unknown, unknown>>(schema: S, value: S['Type']) =>
  Schema.toEquivalence(schema)(Schema.decodeUnknownSync(schema)(Schema.encodeSync(schema)(value)), value)

const generated = {
  Account,
  AccountId,
  AccountRef,
  Actor,
  Agent,
  AgentId,
  Amount,
  AssetId,
  Delivery,
  Digest,
  Grant,
  JobId,
  JobState,
  Listing,
  ListingId,
  NetworkRef,
  PaymentIntent,
  ProposalId,
  Receipt,
  Review,
  RoomId,
  WorkRequest,
}

describe('every record survives encode then decode', () => {
  for (const [name, schema] of Object.entries(generated)) {
    it.prop(name, [schema], ([value]) => roundTrips(schema, value))
  }

  // These carry cross-field rules a random value almost never meets, so they use known-good values.
  const proposal = {
    id: proposalId,
    job: jobId,
    bidder: accountId,
    version: 2,
    previous: 1,
    terms: encodedTerms,
    termsDigest: digest,
  }
  const agreement = {
    job: jobId,
    buyer: otherAccountId,
    worker: accountId,
    proposal: proposalId,
    version: 2,
    terms: encodedTerms,
    termsDigest: digest,
  }
  test.each([
    ['Terms', Terms, encodedTerms],
    ['Proposal', Proposal, proposal],
    ['Agreement', Agreement, agreement],
    ['AssetRef', AssetRef, Schema.encodeSync(AssetRef)(UsdcOnArcTestnet)],
  ] as const)('%s', (_name, schema, encoded) => {
    expect(Schema.encodeSync(schema)(Schema.decodeUnknownSync(schema)(encoded))).toStrictEqual(encoded)
  })
})
