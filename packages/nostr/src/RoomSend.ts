import type { UnixSeconds } from '@sidequest/protocol'
import { Crypto, Effect, Random, Result, Schema } from 'effect'
import type { NostrEvent } from './Event.ts'
import { freshWrapEntropy, sealKind, wrapSeal } from './GiftWrap.ts'
import type { PublicKey } from './PublicKey.ts'
import type { RelayUrl } from './RelayList.ts'
import type { Rumor } from './Rumor.ts'
import type { RelayPort, RelayPortFailure } from './RoomPorts.ts'
import type { RoomSigner, RoomSignerRefused } from './RoomSigner.ts'

// Sending one room message: one gift wrap per recipient, the sender's own copy included (NIP-17: that is how the
// sender's other devices read what it sent), each published to that recipient's inbox relays. Every wrap has a fresh
// one-time key; the seal and the wrap each claim a time up to two days before the real one (NIP-59), chosen apart.

/** NIP-59's window for backdating a seal or a wrap. */
export const backdateSeconds = 2 * 24 * 60 * 60

/** What became of one recipient's copy on one relay; `noInboxRelays` when the recipient named none. */
export interface Delivery {
  readonly recipient: PublicKey
  readonly relay: RelayUrl | null
  readonly outcome: 'sent' | 'refused' | 'noInboxRelays' | RelayPortFailure['reason']
}

/** Why a copy could not be made: the signer refused, or NIP-44 refused the plaintext. */
export class SealRefused extends Schema.TaggedError<SealRefused>()('SealRefused', {
  signer: Schema.optionalKey(Schema.Literals(['noNip44', 'refused', 'untrusted', 'undecryptable', 'cannotDisclose'])),
}) {}

const backdated = (now: UnixSeconds) => Effect.map(Random.nextIntBetween(0, backdateSeconds), (back) => now - back)

const signerFailed = (error: RoomSignerRefused) => new SealRefused({ signer: error.reason })

/** The rumor sealed by its author's signer and wrapped for `recipient`; the seal too, for the sender's own record. */
const sealAndWrap = Effect.fnUntraced(function* (
  signer: RoomSigner,
  rumor: Rumor,
  recipient: PublicKey,
  now: UnixSeconds,
) {
  const content = yield* Effect.mapError(signer.encrypt(recipient, JSON.stringify(rumor)), signerFailed)
  const seal = yield* Effect.mapError(
    signer.signEvent({ created_at: yield* backdated(now), kind: sealKind, tags: [], content }),
    signerFailed,
  )
  const entropy = yield* freshWrapEntropy
  const wrapAt = yield* backdated(now)
  const wrap = yield* Effect.fromResult(
    Result.mapError(wrapSeal(seal, recipient, wrapAt, entropy), () => new SealRefused({})),
  )
  return { seal, wrap }
})

const outcomeOf = (relay: RelayUrl, recipient: PublicKey) => ({
  onSuccess: (ack: { readonly accepted: boolean; readonly message: string }): Delivery => ({
    recipient,
    relay,
    // A relay that already holds the wrap has it: that is delivered.
    outcome: ack.accepted || ack.message.startsWith('duplicate:') ? 'sent' : 'refused',
  }),
  onFailure: (failure: RelayPortFailure): Delivery => ({ recipient, relay, outcome: failure.reason }),
})

/** Publishes one recipient's wrap to each of its relays, and says how each went. */
const deliver = (
  port: RelayPort,
  recipient: PublicKey,
  relays: ReadonlyArray<RelayUrl>,
  wrap: NostrEvent,
): Effect.Effect<ReadonlyArray<Delivery>> =>
  relays.length === 0
    ? Effect.succeed([{ recipient, relay: null, outcome: 'noInboxRelays' }])
    : Effect.forEach(relays, (relay) => Effect.match(port.publish(relay, wrap), outcomeOf(relay, recipient)), {
        concurrency: 4,
      })

/** Every recipient's copy, made one after another (an extension may ask the person for each), then delivered. */
export const sendCopies = Effect.fnUntraced(function* (
  ports: { readonly signer: RoomSigner; readonly relays: RelayPort },
  rumor: Rumor,
  recipients: ReadonlyArray<{ readonly recipient: PublicKey; readonly relays: ReadonlyArray<RelayUrl> }>,
  now: UnixSeconds,
): Effect.fn.Return<
  { readonly ownSeal: NostrEvent; readonly ownWrap: NostrEvent; readonly deliveries: ReadonlyArray<Delivery> },
  SealRefused,
  Crypto.Crypto
> {
  const copies = yield* Effect.forEach(recipients, (target) =>
    Effect.map(sealAndWrap(ports.signer, rumor, target.recipient, now), (made) => ({ ...target, ...made })),
  )
  const deliveries = yield* Effect.forEach(
    copies,
    (copy) => deliver(ports.relays, copy.recipient, copy.relays, copy.wrap),
    {
      concurrency: 2,
    },
  )
  const own = copies.find((copy) => copy.recipient === ports.signer.publicKey)
  if (own === undefined) return yield* new SealRefused({})
  return { ownSeal: own.seal, ownWrap: own.wrap, deliveries: deliveries.flat() }
})
