import { Result, Schema } from 'effect'
import { decodeBech32, encodeBech32, type InvalidBech32 } from './Bech32.ts'
import { EventId } from './Event.ts'
import { bytesOf, hexOf } from './Hex.ts'
import { SecretKey } from './Keys.ts'
import { PublicKey } from './PublicKey.ts'

/** A bech32 string that is valid but not a 32-byte `npub`, `nsec` or `note`, or whose secret is not a valid scalar. */
export class UnsupportedEntity extends Schema.TaggedError<UnsupportedEntity>()('UnsupportedEntity', {
  prefix: Schema.String,
}) {}

/** A bare NIP-19 entity: a public key, a secret key or an event id, each 32 bytes. */
export type BareEntity =
  | { readonly type: 'npub'; readonly data: PublicKey }
  | { readonly type: 'nsec'; readonly data: SecretKey }
  | { readonly type: 'note'; readonly data: EventId }

/** `npub1…` for a public key, for people to read and paste; events always carry hex. */
export const encodeNpub = (key: PublicKey): string => encodeBech32('npub', bytesOf(key))

/** `nsec1…` for a secret key. */
export const encodeNsec = (key: SecretKey): string => encodeBech32('nsec', bytesOf(key))

/** `note1…` for an event id. */
export const encodeNote = (id: EventId): string => encodeBech32('note', bytesOf(id))

const entityOf = (prefix: string, hex: string): BareEntity | undefined => {
  if (prefix === 'npub') return { type: 'npub', data: PublicKey.make(hex) }
  if (prefix === 'note') return { type: 'note', data: EventId.make(hex) }
  if (prefix === 'nsec' && Schema.is(SecretKey)(hex)) return { type: 'nsec', data: hex }
  return undefined
}

/** Reads an `npub`, `nsec` or `note`. TLV entities (`nprofile`, `nevent`, `naddr`) are not supported yet. */
export const decodeNip19 = (text: string): Result.Result<BareEntity, InvalidBech32 | UnsupportedEntity> =>
  Result.flatMap(decodeBech32(text), ({ prefix, bytes }) => {
    const entity = bytes.length === 32 ? entityOf(prefix, hexOf(bytes)) : undefined
    return entity === undefined ? Result.fail(new UnsupportedEntity({ prefix })) : Result.succeed(entity)
  })
