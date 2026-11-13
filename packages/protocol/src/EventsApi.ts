import { Schema, SchemaTransformation } from 'effect'
import { AccountRef } from './AccountRef.ts'
import { Erc8004Identities } from './Erc8004Identity.ts'
import { GrantScope } from './Grant.ts'
import { Hex32 } from './Hex32.ts'

/**
 * A signed Nostr event as JSON (NIP-01), in the shape a client sends and the index serves. The shape only: the server
 * recomputes the id and checks the signature, and reads Sidequest's kinds with `@sidequest/nostr`.
 */
export const SignedEvent = Schema.Struct({
  id: Schema.String,
  pubkey: Schema.String,
  created_at: Schema.Int,
  kind: Schema.Int,
  tags: Schema.Array(Schema.Array(Schema.String)),
  content: Schema.String,
  sig: Schema.String,
})
export type SignedEvent = typeof SignedEvent.Type

/** What publishing did: stored the event, or found it stored already. */
export const Published = Schema.Struct({ id: Hex32, status: Schema.Literals(['stored', 'duplicate']) })
export type Published = typeof Published.Type

/**
 * Why an event is not valid: not an event's shape, an id that is not its hash, a signature that fails, or (for
 * Sidequest's kinds and listings) content, envelope, network or tags the vocabulary refuses.
 */
export const EventInvalidReason = Schema.Literals([
  'malformed',
  'idMismatch',
  'badSignature',
  'badContent',
  'badEnvelope',
  'networkMismatch',
  'tagMismatch',
  'inconsistentContent',
])

export class EventInvalid extends Schema.TaggedError<EventInvalid>()(
  'EventInvalid',
  { reason: EventInvalidReason },
  { httpApiStatus: 400 },
) {}

/** The index keeps profiles, relay lists, listings and Sidequest's kinds; this event is of another kind. */
export class KindNotIndexed extends Schema.TaggedError<KindNotIndexed>()(
  'KindNotIndexed',
  { kind: Schema.Int },
  { httpApiStatus: 422 },
) {}

/** The event's content, tags or whole serialization is larger than the index keeps. */
export class EventTooLarge extends Schema.TaggedError<EventTooLarge>()('EventTooLarge', {}, { httpApiStatus: 413 }) {}

/** This client or this key published too much lately; it may try again after `retryAfterSeconds`. */
export class RateLimited extends Schema.TaggedError<RateLimited>()(
  'RateLimited',
  { retryAfterSeconds: Schema.Int },
  { httpApiStatus: 429 },
) {}

/** The index has no such event, knows nothing of that key, or holds no such listing or job. */
export class NotIndexed extends Schema.TaggedError<NotIndexed>()('NotIndexed', {}, { httpApiStatus: 404 }) {}

/** Where a person's latest list came from: its event and when they signed it. */
const Origin = { event: Hex32, createdAt: Schema.Int }

/**
 * A key's link to a wallet: the CAIP-10 account, the wallet-link event and the `issuedAt` the wallet signed.
 * `verification` is `verified` when the wallet's EIP-712 signature recovers to the account, and `unverified` when the
 * index cannot tell (an ERC-1271 contract wallet's signature needs a call to its chain, which the index does not make).
 */
export const WalletLink = Schema.Struct({
  account: AccountRef,
  event: Hex32,
  issuedAt: Schema.Int,
  verification: Schema.Literals(['verified', 'unverified']),
})
export type WalletLink = typeof WalletLink.Type

/** A grant as of the read: revoked by its operator, not yet valid, past its expiry, or active. */
export const AgentGrantStatus = Schema.Literals(['active', 'expired', 'notYet', 'revoked'])
export type AgentGrantStatus = typeof AgentGrantStatus.Type

/**
 * An agent grant (ADR-0003, decision 7): its event, the operator who signed it, the agent key it lets act, the scopes,
 * the window from `notBefore` to `expiresAt`, and its status at the time of the read.
 */
export const AgentGrantView = Schema.Struct({
  event: Hex32,
  operator: Hex32,
  agent: Hex32,
  scopes: Schema.Array(GrantScope),
  notBefore: Schema.Int,
  expiresAt: Schema.Int,
  label: Schema.String,
  status: AgentGrantStatus,
})
export type AgentGrantView = typeof AgentGrantView.Type

/**
 * What the index knows of a key: its latest profile (kind 0), its latest relay list (NIP-65, kind 10002) and its
 * latest messaging relays (NIP-17, kind 10050), each `null` until one is seen. "Latest" is the greatest `created_at`,
 * ties to the lowest event id, whatever order the events arrived in.
 *
 * `wallets` are the accounts this key is currently linked to: of every verified link naming an account, the greatest
 * `issuedAt` wins, ties to the lowest event id, so a wallet that re-links to another key leaves this one.
 * `unverifiedWallets` are links this key signed that the index could not verify; they never link an account. `agents`
 * are the grants this key gave, and `operators` the unrevoked grants it received, each with its status at the time of
 * the read. A revocation counts only when the grant's own operator signed it. `erc8004` are the claims that an
 * ERC-8004 identity stands for this key, each as verified as the index's latest read of its token left it (ADR-0007).
 */
export const Person = Schema.Struct({
  pubkey: Hex32,
  profile: Schema.NullOr(
    Schema.Struct({
      name: Schema.NullOr(Schema.String),
      about: Schema.NullOr(Schema.String),
      picture: Schema.NullOr(Schema.String),
      ...Origin,
    }),
  ),
  relays: Schema.NullOr(
    Schema.Struct({ read: Schema.Array(Schema.String), write: Schema.Array(Schema.String), ...Origin }),
  ),
  messagingRelays: Schema.NullOr(Schema.Struct({ relays: Schema.Array(Schema.String), ...Origin })),
  wallets: Schema.Array(WalletLink),
  unverifiedWallets: Schema.Array(WalletLink),
  agents: Schema.Array(AgentGrantView),
  operators: Schema.Array(AgentGrantView),
  erc8004: Erc8004Identities,
})
export type Person = typeof Person.Type

/** The key a wallet is currently linked to: its winning verified link, by the rule `Person.wallets` describes. */
export const LinkedWallet = Schema.Struct({ ...WalletLink.fields, pubkey: Hex32 })
export type LinkedWallet = typeof LinkedWallet.Type

/** The most keys one names lookup takes: a page of a job's people, or of a list. */
export const maxPeoplePerLookup = 50

/** Public keys in the query string, comma separated: one to {@link maxPeoplePerLookup}, each once. */
export const Pubkeys = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Array(Hex32).check(Schema.isMinLength(1), Schema.isMaxLength(maxPeoplePerLookup), Schema.isUnique()),
    SchemaTransformation.transform<ReadonlyArray<string>, string>({
      decode: (pubkeys) => pubkeys.split(','),
      encode: (pubkeys) => pubkeys.join(','),
    }),
  ),
)

/**
 * How a page names a key: its latest profile's name (`null` without a profile or a name in it), and whether a wallet
 * is currently linked to it by a verified link (`Person.wallets` is not empty).
 */
export const PersonName = Schema.Struct({
  pubkey: Hex32,
  name: Schema.NullOr(Schema.String),
  walletVerified: Schema.Boolean,
})
export type PersonName = typeof PersonName.Type

/**
 * A job a key is a party to, as a client's inbox finds it: the job (its request event's id), whether the key wrote the
 * request (`buyer`) or a proposal for it (`bidder`; its own, or its agent's under its grant), and when it last did (the
 * request's or its newest proposal's `created_at`).
 */
export const KeyJob = Schema.Struct({ job: Hex32, role: Schema.Literals(['buyer', 'bidder']), at: Schema.Int })
export type KeyJob = typeof KeyJob.Type

/** The most jobs one read of a key's jobs answers, newest first. */
export const maxKeyJobs = 25
