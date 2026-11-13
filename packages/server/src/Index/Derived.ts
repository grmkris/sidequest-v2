import type { NostrEvent } from '@sidequest/nostr'
import {
  type AgentGrantContent,
  type Erc8004ClaimContent,
  type GrantRevocationContent,
  grantOf as grantNamed,
  type MessagingRelays,
  type ParsedEvent,
  type ParsedListing,
  type PaymentReceiptContent,
  type ProfileName,
  type RelayList,
  recoverAddress,
  type WalletLinkContent,
  walletLinkDigest,
} from '@sidequest/nostr/vocabulary'
import type { AccountRef, GrantScope } from '@sidequest/protocol'
import { Option, Schema } from 'effect'

/** The event a derived row came from, and when its author signed it: what decides which row is the latest. */
export interface Origin {
  readonly pubkey: string
  readonly eventId: string
  readonly createdAt: number
}

/** A key's profile as the index keeps it: a name, an about text and a picture, each only when well formed. */
export interface ProfileRow extends Origin {
  readonly name: string | null
  readonly about: string | null
  readonly picture: string | null
}

/** A key's relay list (10002) or messaging relays (10050, whose relays are all `read`). */
export interface RelayListRow extends Origin {
  readonly kind: number
  readonly read: ReadonlyArray<string>
  readonly write: ReadonlyArray<string>
}

/** Whether the index could check a wallet link's wallet signature and it held, or could not tell. */
export type Verification = 'verified' | 'unverified'

/** A key's link to a wallet, as a CAIP-10 account, from one wallet-link event. */
export interface WalletLinkRow {
  readonly eventId: string
  readonly account: AccountRef
  readonly pubkey: string
  readonly issuedAt: number
  readonly verification: Verification
}

/** An operator (the grant's author) lets an agent key act for them with these scopes from `notBefore` to `expiresAt`. */
export interface GrantRow {
  readonly eventId: string
  readonly operator: string
  readonly agent: string
  readonly scopes: ReadonlyArray<GrantScope>
  readonly notBefore: number
  readonly expiresAt: number
  readonly label: string
  readonly createdAt: number
}

/** A revocation of a grant, by whoever signed it: it counts only when that is the grant's operator. */
export interface RevocationRow {
  readonly eventId: string
  readonly grant: string
  readonly pubkey: string
}

/**
 * A seller's latest listing under one slug: what search and display need. `network` is the CAIP-2 chain of the price
 * hint's asset (a listing names no network of its own), `null` without a price.
 */
export interface ListingRow extends Origin {
  readonly slug: string
  readonly title: string
  readonly summary: string
  readonly description: string
  readonly topics: ReadonlyArray<string>
  readonly price: { readonly amount: string; readonly asset: string } | null
  readonly network: string | null
  readonly status: 'active' | 'sold'
  readonly publishedAt: number
  /** A pay-per-call listing's resource and the CAIP-10 account paid, `null` on an escrow listing. */
  readonly x402: { readonly resource: string; readonly payTo: string } | null
}

/** A buyer's receipt for one paid call, by its author, under the grant it names if an agent's key signed it. */
export interface ReceiptRow extends Origin {
  readonly grant: string | null
  readonly content: PaymentReceiptContent
}

/** A claim that an ERC-8004 token stands for `subject`, by `author`, who should own it (ADR-0007). */
export interface Erc8004ClaimRow {
  readonly eventId: string
  readonly author: string
  readonly subject: string
  readonly registry: string
  readonly agentId: string
  readonly mcp: string | null
  readonly createdAt: number
}

/** What an event derives: a profile, a relay list, a listing, a wallet link, a grant, a revocation, a receipt or an
 * ERC-8004 claim. */
export type Derived =
  | { readonly table: 'profiles'; readonly row: ProfileRow }
  | { readonly table: 'listings'; readonly row: ListingRow }
  | { readonly table: 'relay_lists'; readonly row: RelayListRow }
  | { readonly table: 'wallet_links'; readonly row: WalletLinkRow }
  | { readonly table: 'agent_grants'; readonly row: GrantRow }
  | { readonly table: 'grant_revocations'; readonly row: RevocationRow }
  | { readonly table: 'x402_receipts'; readonly row: ReceiptRow }
  | { readonly table: 'erc8004_claims'; readonly row: Erc8004ClaimRow }

/**
 * Whether `candidate` replaces `current` as a key's latest of a kind: NIP-01's rule for replaceable events, the
 * greatest `created_at`, and of two made in the same second the lowest id. A total order on distinct events, so the
 * latest of any set is the same whatever order the set arrived in.
 */
export const supersedes = (candidate: Origin, current: Origin): boolean =>
  candidate.createdAt > current.createdAt ||
  (candidate.createdAt === current.createdAt && candidate.eventId < current.eventId)

const originOf = (event: NostrEvent): Origin => ({
  pubkey: event.pubkey,
  eventId: event.id,
  createdAt: event.created_at,
})

const About = Schema.String.check(Schema.isMaxLength(2000))
const Picture = Schema.String.check(Schema.isMaxLength(2000), Schema.isPattern(/^https:\/\/[^\s]+$/u))

// Other clients write all sorts into kind 0; only these fields are read, and a malformed one is dropped, not fatal.
const ProfileExtras = Schema.fromJsonString(
  Schema.Struct({ about: Schema.optionalKey(Schema.Unknown), picture: Schema.optionalKey(Schema.Unknown) }),
)

const valueOf = <A>(schema: Schema.Decoder<A>, value: unknown): string | null =>
  Option.getOrNull(Option.map(Schema.decodeUnknownOption(schema)(value), String))

/** The profile row of a kind-0 event `parseProfileName` read: its name (or display name), about text and https picture. */
export const profileOf = (event: NostrEvent, names: ProfileName): Derived => {
  const extras = Option.getOrElse(Schema.decodeUnknownOption(ProfileExtras)(event.content), () => ({}))
  return {
    table: 'profiles',
    row: {
      ...originOf(event),
      name: Option.getOrNull(Option.orElse(names.name, () => names.displayName)),
      about: 'about' in extras ? valueOf(About, extras.about) : null,
      picture: 'picture' in extras ? valueOf(Picture, extras.picture) : null,
    },
  }
}

/** The listing row of a NIP-99 listing `parseServiceListing` read. */
export const listingOf = (event: NostrEvent, { listing }: ParsedListing): Derived => ({
  table: 'listings',
  row: {
    ...originOf(event),
    slug: listing.slug,
    title: listing.title,
    summary: listing.summary,
    description: listing.description,
    topics: listing.topics,
    price: listing.price === undefined ? null : { amount: listing.price.amount, asset: listing.price.asset },
    network: listing.price === undefined ? null : listing.price.asset.slice(0, listing.price.asset.indexOf('/')),
    status: listing.status,
    publishedAt: listing.publishedAt,
    x402: listing.x402 === undefined ? null : { resource: listing.x402.resource, payTo: listing.x402.payTo },
  },
})

/** The receipt row of a payment receipt the vocabulary read. */
export const receiptOf = ({ event, content }: ParsedEvent<PaymentReceiptContent>): Derived => ({
  table: 'x402_receipts',
  row: { ...originOf(event), grant: Option.getOrNull(grantNamed(event)), content },
})

/** The relay-list row of a NIP-65 list. */
export const relayListOf = (event: NostrEvent, list: RelayList): Derived => ({
  table: 'relay_lists',
  row: { ...originOf(event), kind: event.kind, read: list.read, write: list.write },
})

/** The relay-list row of a NIP-17 messaging relay list: where its author reads private messages. */
export const messagingRelaysOf = (event: NostrEvent, list: MessagingRelays): Derived => ({
  table: 'relay_lists',
  row: { ...originOf(event), kind: event.kind, read: list.relays, write: [] },
})

/**
 * Whether a wallet link's signature recovers to the wallet it names: the EIP-712 digest of `LinkNostrKey(pubkey,
 * issuedAt)` on the account's chain, recovered as `ecrecover` does. `@sidequest/nostr` reads the link but leaves this to
 * the indexer. Anything that does not recover to the address is `unverified`, not refused: an ERC-1271 contract
 * wallet's signature (of any length, 65 bytes included) can only be checked by calling the wallet on its chain, which
 * the index does not do, and a forgery looks the same from here. A chain id too large to be a safe integer cannot be
 * hashed exactly, so it does not verify either.
 */
export const verifyWalletLink = (event: NostrEvent, content: WalletLinkContent): Verification => {
  const [, chain = '', address = ''] = content.address.split(':')
  const chainId = Number(chain)
  if (!Number.isSafeInteger(chainId)) return 'unverified'
  const recovered = recoverAddress(walletLinkDigest(event.pubkey, content.issuedAt, chainId), content.walletSignature)
  return Option.exists(recovered, (wallet) => wallet === address) ? 'verified' : 'unverified'
}

/** The wallet-link row of a kind-8410 event the vocabulary read, labelled by whether its wallet signature verified. */
export const walletLinkOf = ({ event, content }: ParsedEvent<WalletLinkContent>): Derived => ({
  table: 'wallet_links',
  row: {
    eventId: event.id,
    account: content.address,
    pubkey: event.pubkey,
    issuedAt: content.issuedAt,
    verification: verifyWalletLink(event, content),
  },
})

/** The grant row of an agent grant the vocabulary read: its author is the operator. */
export const grantOf = ({ event, content }: ParsedEvent<AgentGrantContent>): Derived => ({
  table: 'agent_grants',
  row: {
    eventId: event.id,
    operator: event.pubkey,
    agent: content.agent,
    scopes: content.scopes,
    notBefore: content.notBefore,
    expiresAt: content.expiresAt,
    label: content.label,
    createdAt: event.created_at,
  },
})

/** The revocation row of a grant revocation the vocabulary read, whoever signed it. */
export const revocationOf = ({ event, content }: ParsedEvent<GrantRevocationContent>): Derived => ({
  table: 'grant_revocations',
  row: { eventId: event.id, grant: content.grant, pubkey: event.pubkey },
})

/** The claim row of an ERC-8004 claim the vocabulary read: its author is who should own the token. */
export const erc8004ClaimOf = ({ event, content }: ParsedEvent<Erc8004ClaimContent>): Derived => ({
  table: 'erc8004_claims',
  row: {
    eventId: event.id,
    author: event.pubkey,
    subject: content.subject,
    registry: content.registry,
    agentId: content.agentId,
    mcp: content.mcp ?? null,
    createdAt: event.created_at,
  },
})

/** A grant as of a moment: revoked by its operator, not yet valid, expired, or active. */
export type GrantStatus = 'active' | 'expired' | 'notYet' | 'revoked'

/**
 * A grant's status at `now`, in Unix seconds: revoked whenever its operator revoked it, otherwise active from
 * `notBefore` up to but not including `expiresAt`. Expiry is never stored; every read asks it of its own `now`.
 */
export const grantStatus = (
  grant: { readonly notBefore: number; readonly expiresAt: number; readonly revoked: boolean },
  now: number,
): GrantStatus => {
  if (grant.revoked) return 'revoked'
  if (now < grant.notBefore) return 'notYet'
  return now < grant.expiresAt ? 'active' : 'expired'
}
