import { Effect, Schema } from 'effect'
import { webCrypto } from './WebCrypto.ts'

const prefixes = {
  AccountId: 'account',
  AgentId: 'agent',
  ListingId: 'listing',
  JobId: 'job',
  RoomId: 'room',
  ProposalId: 'proposal',
} as const
type IdKind = keyof typeof prefixes

// `<prefix>_<ULID>`: a 48-bit millisecond time then 80 random bits in Crockford base32. The first
// ULID character is at most 7 because 26 characters hold 130 bits.
const id = (kind: IdKind) =>
  Schema.String.check(Schema.isPattern(new RegExp(`^${prefixes[kind]}_[0-7][0-9A-HJKMNP-TV-Z]{25}$`)))

export const AccountId = id('AccountId').pipe(Schema.brand('AccountId'))
export type AccountId = typeof AccountId.Type
export const AgentId = id('AgentId').pipe(Schema.brand('AgentId'))
export type AgentId = typeof AgentId.Type
export const ListingId = id('ListingId').pipe(Schema.brand('ListingId'))
export type ListingId = typeof ListingId.Type
export const JobId = id('JobId').pipe(Schema.brand('JobId'))
export type JobId = typeof JobId.Type
export const RoomId = id('RoomId').pipe(Schema.brand('RoomId'))
export type RoomId = typeof RoomId.Type
export const ProposalId = id('ProposalId').pipe(Schema.brand('ProposalId'))
export type ProposalId = typeof ProposalId.Type

const ids = { AccountId, AgentId, ListingId, JobId, RoomId, ProposalId }

/** Mints a fresh, time-ordered id of the given kind. */
export const generateId = <Kind extends IdKind>(kind: Kind): Effect.Effect<(typeof ids)[Kind]['Type']> =>
  webCrypto.randomULID.pipe(
    // Crypto.make's ULID fails only for an invalid byte count, and it always asks for ten.
    Effect.orDie,
    Effect.map((ulid) => ids[kind].make(`${prefixes[kind]}_${ulid}`)),
  )
