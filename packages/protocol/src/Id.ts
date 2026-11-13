import { Effect, Schema } from 'effect'
import { webCrypto } from './WebCrypto.ts'

const prefixes = {
  ConnectionId: 'connection',
  ConnectRequestId: 'connect',
} as const
type IdKind = keyof typeof prefixes

// A ULID: a 48-bit millisecond time then 80 random bits in Crockford base32. The first character is at most 7
// because 26 characters hold 130 bits.
const ulid = '[0-7][0-9A-HJKMNP-TV-Z]{25}'

// `<prefix>_<ULID>`.
const id = (kind: IdKind) => Schema.String.check(Schema.isPattern(new RegExp(`^${prefixes[kind]}_${ulid}$`, 'u')))

// The agent gateway's own records mint these. Everything Sidequest coordinates is named by a Nostr event id or a
// public key instead (ADR-0003).

/** One consent a person gave an MCP client to act as one of their agents, over OAuth. */
export const ConnectionId = id('ConnectionId').pipe(Schema.brand('ConnectionId'))
export type ConnectionId = typeof ConnectionId.Type
/** An MCP client's OAuth authorization request, waiting for the person's consent. */
export const ConnectRequestId = id('ConnectRequestId').pipe(Schema.brand('ConnectRequestId'))
export type ConnectRequestId = typeof ConnectRequestId.Type

const ids = { ConnectionId, ConnectRequestId }

/** Mints a fresh, time-ordered id of the given kind. */
export const generateId = <Kind extends IdKind>(kind: Kind): Effect.Effect<(typeof ids)[Kind]['Type']> =>
  webCrypto.randomULID.pipe(
    // Crypto.make's ULID fails only for an invalid byte count, and it always asks for ten.
    Effect.orDie,
    Effect.map((value) => ids[kind].make(`${prefixes[kind]}_${value}`)),
  )
