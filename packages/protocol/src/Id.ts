import { Effect, Schema } from 'effect'
import { webCrypto } from './WebCrypto.ts'

const prefixes = {
  AccountId: 'account',
  AgentId: 'agent',
  ListingId: 'listing',
  JobId: 'job',
  ProposalId: 'proposal',
  AgentTokenId: 'token',
} as const
type IdKind = keyof typeof prefixes

// A ULID: a 48-bit millisecond time then 80 random bits in Crockford base32. The first character is at most 7
// because 26 characters hold 130 bits.
const ulid = '[0-7][0-9A-HJKMNP-TV-Z]{25}'

// `<prefix>_<ULID>`.
const id = (kind: IdKind) => Schema.String.check(Schema.isPattern(new RegExp(`^${prefixes[kind]}_${ulid}$`, 'u')))

export const AccountId = id('AccountId').pipe(Schema.brand('AccountId'))
export type AccountId = typeof AccountId.Type
export const AgentId = id('AgentId').pipe(Schema.brand('AgentId'))
export type AgentId = typeof AgentId.Type
export const ListingId = id('ListingId').pipe(Schema.brand('ListingId'))
export type ListingId = typeof ListingId.Type
export const JobId = id('JobId').pipe(Schema.brand('JobId'))
export type JobId = typeof JobId.Type
export const ProposalId = id('ProposalId').pipe(Schema.brand('ProposalId'))
export type ProposalId = typeof ProposalId.Type
/** An access token an operator issued to one of their agents. The id names it; it is not the secret. */
export const AgentTokenId = id('AgentTokenId').pipe(Schema.brand('AgentTokenId'))
export type AgentTokenId = typeof AgentTokenId.Type

/** A negotiation room is the buyer and one bidder; an engagement room is the buyer and the worker. */
export const RoomKind = Schema.Literals(['negotiation', 'engagement'])
export type RoomKind = typeof RoomKind.Type

/**
 * A room is never minted: its id derives from its job, its kind and, for a negotiation, the bidder, so whoever opens
 * it names the same room. `room_<job ULID>_engagement` or `room_<job ULID>_negotiation_<bidder ULID>`.
 */
export const RoomId = Schema.String.check(
  Schema.isPattern(new RegExp(`^room_${ulid}_(?:engagement|negotiation_${ulid})$`, 'u')),
).pipe(Schema.brand('RoomId'))
export type RoomId = typeof RoomId.Type

/** Which room: the job's engagement room, or the negotiation room of one bidder on it. */
export type RoomOf =
  | { readonly job: JobId; readonly kind: 'engagement' }
  | { readonly job: JobId; readonly kind: 'negotiation'; readonly bidder: AccountId }

const ulidOf = (prefixed: string) => prefixed.slice(prefixed.indexOf('_') + 1)

/** The id of a room, from what identifies it. */
export const roomIdOf = (room: RoomOf): RoomId =>
  RoomId.make(
    room.kind === 'engagement'
      ? `room_${ulidOf(room.job)}_engagement`
      : `room_${ulidOf(room.job)}_negotiation_${ulidOf(room.bidder)}`,
  )

const ids = { AccountId, AgentId, ListingId, JobId, ProposalId, AgentTokenId }

/** Mints a fresh, time-ordered id of the given kind. */
export const generateId = <Kind extends IdKind>(kind: Kind): Effect.Effect<(typeof ids)[Kind]['Type']> =>
  webCrypto.randomULID.pipe(
    // Crypto.make's ULID fails only for an invalid byte count, and it always asks for ten.
    Effect.orDie,
    Effect.map((value) => ids[kind].make(`${prefixes[kind]}_${value}`)),
  )
