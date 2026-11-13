import type { PublicKey } from '@sidequest/nostr'
import { type AuthSigner, connectRelay, type RelayFailure } from '@sidequest/nostr/relay'
import { type RelayPort, RelayPortFailure } from '@sidequest/nostr/rooms'
import { RelayUrl } from '@sidequest/nostr/vocabulary'
import { Context, Duration, Effect, Layer, Option, Schema } from 'effect'
import { Core } from '../Core/Core.ts'
import { GatewaySettings } from '../Settings.ts'

// How the gateway reaches an agent's rooms: the relays, dialled from the Worker with the repository's own NIP-01
// client (never the browser's pipe), answering NIP-42 challenges with the agent's key; and where a key receives
// private messages, from the kind-10050 list the core's index holds for it.

/** The gateway's way to relays and to people's inbox relays. */
export class RoomNetwork extends Context.Service<
  RoomNetwork,
  {
    /** The relays, authenticating as whoever `auth` signs for. */
    readonly port: (auth: AuthSigner) => RelayPort
    /** The inbox relays the index knows for `pubkey`; none when it knows none or does not answer. */
    readonly inboxRelays: (pubkey: PublicKey) => Effect.Effect<ReadonlyArray<RelayUrl>>
    /** Whether the gateway may dial this relay. */
    readonly allows: (url: string) => boolean
  }
>()('Sidequest/Gateway/RoomNetwork') {
  /** Over the core's index and the Worker's `WebSocket`. */
  static readonly layer = Layer.effect(
    RoomNetwork,
    Effect.gen(function* () {
      const core = yield* Core
      const { relayPolicy } = yield* GatewaySettings
      const allowed = (url: string) => allowedRelay(url, relayPolicy ?? 'public')
      return RoomNetwork.of({
        port: (auth) => relayPortOver(auth, allowed),
        allows: allowed,
        inboxRelays: (pubkey) =>
          core.person(pubkey).pipe(
            Effect.map((found) =>
              Option.match(found, {
                onNone: () => [],
                onSome: (person) => (person.messagingRelays?.relays ?? []).filter(allowed).flatMap(decodeRelay),
              }),
            ),
            Effect.orElseSucceed(() => []),
          ),
      })
    }),
  )
}

const decodeRelay = (url: string) => Option.toArray(Schema.decodeUnknownOption(RelayUrl)(url))

// A DNS name of labels ending in an alphabetic top-level label: no IP literal, no single-label name.
const publicName = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u
const privateEndings = ['.localhost', '.local', '.internal', '.lan', '.home.arpa', '.test', '.invalid', '.example']

/**
 * Whether the gateway may dial `url`: `wss` on port 443 to a public host name, as the core's relay pipe allows; under
 * the `local` policy (native tests alone) also `ws://127.0.0.1`.
 */
export const allowedRelay = (url: string, policy: 'public' | 'local'): boolean => {
  if (!URL.canParse(url)) return false
  const parsed = new URL(url)
  if (parsed.username !== '' || parsed.password !== '' || parsed.hash !== '') return false
  const host = parsed.hostname
  const isPublic =
    parsed.protocol === 'wss:' &&
    parsed.port === '' &&
    publicName.test(host) &&
    !privateEndings.some((ending) => host.endsWith(ending))
  return isPublic || (policy === 'local' && parsed.protocol === 'ws:' && host === '127.0.0.1')
}

const timing = {
  connectTimeout: Duration.seconds(5),
  replyTimeout: Duration.seconds(10),
  maxFrameLength: 262_144,
}

const portFailure = (failure: RelayFailure) => new RelayPortFailure({ relay: failure.relay, reason: failure.reason })

/** One connection per call, closed when the call ends: a tool call reads or sends once, and a Worker keeps nothing. */
const relayPortOver = (auth: AuthSigner, allowed: (url: string) => boolean): RelayPort => {
  const onConnection = <A>(
    relay: string,
    use: (connection: Effect.Success<ReturnType<typeof connectRelay>>) => Effect.Effect<A, RelayFailure>,
  ) =>
    allowed(relay)
      ? Effect.scoped(Effect.flatMap(connectRelay(relay, { ...timing, auth: Option.some(auth) }), use)).pipe(
          Effect.mapError(portFailure),
        )
      : Effect.fail(new RelayPortFailure({ relay, reason: 'refused' }))
  return {
    publish: (relay, event) => onConnection(relay, (connection) => connection.publish(event)),
    query: (relay, filter) => onConnection(relay, (connection) => connection.query(filter)),
  }
}
