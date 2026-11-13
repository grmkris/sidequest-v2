import { it } from '@effect/vitest'
import { publicKeyOf, type SecretKey } from '@sidequest/nostr'
import { standardKinds } from '@sidequest/nostr/vocabulary'
import { Effect, Option } from 'effect'
import { describe, expect } from 'vitest'
import { connectRelay, type RelayConnection } from '../src/Index/RelayClient.ts'
import { alice, profile, request, service, testTiming } from './IndexWorld.ts'
import { startTestRelay, type TestRelay } from './TestRelay.ts'

const at = 1_800_000_000
const options = { ...testTiming, authKey: Option.none<SecretKey>() }

/** Runs `use` with a fresh test relay (closed afterwards) and a connection to it. */
const withRelay = <A, E>(
  use: (relay: TestRelay, connection: RelayConnection) => Effect.Effect<A, E>,
  setup: Parameters<typeof startTestRelay>[0] = {},
  client = options,
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => startTestRelay(setup)),
    (relay) => Effect.scoped(Effect.flatMap(connectRelay(relay.url, client), (connection) => use(relay, connection))),
    (relay) => Effect.promise(() => relay.close()),
  )

/** The reason a relay call failed, or `ok`. */
const reasonOf = <A, R>(effect: Effect.Effect<A, { readonly reason: string }, R>) =>
  effect.pipe(
    Effect.as('ok'),
    Effect.catch((failure) => Effect.succeed(failure.reason)),
  )

describe('the relay client', () => {
  it.live('publishes an event and reads OK, and reads a duplicate as the relay says it', () =>
    withRelay((relay, connection) =>
      Effect.gen(function* () {
        const event = request(alice, at)
        expect(yield* connection.publish(event)).toEqual({ accepted: true, message: '' })
        expect(relay.published).toEqual([event.id])
        expect((yield* connection.publish(event)).message).toMatch(/^duplicate:/)
      }),
    ),
  )

  it.live('reads a refusal as the relay words it', () =>
    withRelay(
      (_, connection) =>
        Effect.map(connection.publish(request(alice, at)), (reply) =>
          expect(reply).toEqual({ accepted: false, message: 'blocked: not here' }),
        ),
      { refuse: () => 'blocked: not here' },
    ),
  )

  it.live('queries until EOSE, and pages with since, until and limit as asked', () =>
    withRelay((relay, connection) =>
      Effect.gen(function* () {
        const events = [0, 1, 2, 3, 4].map((offset) => request(alice, at + offset, `Job ${offset}`))
        relay.seed(...events, profile(alice, at, { name: 'Alice' }))
        const newest = yield* connection.query({ kinds: [events[0]?.kind ?? 0], limit: 2 })
        expect(newest).toEqual([events[4], events[3]])
        const older = yield* connection.query({ kinds: [events[0]?.kind ?? 0], until: at + 2, since: at + 1 })
        expect(older).toEqual([events[2], events[1]])
        expect(yield* connection.query({ kinds: [standardKinds.profile], authors: [publicKeyOf(alice)] })).toHaveLength(
          1,
        )
      }),
    ),
  )

  it.live('fails a query whose relay never sends EOSE, rather than return what came so far', () =>
    withRelay(
      (relay, connection) => {
        relay.seed(request(alice, at))
        return Effect.map(reasonOf(connection.query({ kinds: [standardKinds.profile] })), (reason) =>
          expect(reason).toBe('timeout'),
        )
      },
      { silent: true },
    ),
  )

  it.live('authenticates with NIP-42 when the relay demands it, for reading and for publishing', () =>
    withRelay(
      (relay, connection) =>
        Effect.gen(function* () {
          relay.seed(request(alice, at))
          expect(yield* connection.query({ kinds: [request(alice, at).kind] })).toHaveLength(1)
          expect([...relay.authenticated]).toEqual([publicKeyOf(service)])
          expect((yield* connection.publish(request(alice, at + 1))).accepted).toBe(true)
        }),
      { auth: true },
      { ...options, authKey: Option.some(service) },
    ),
  )

  it.live('without a key, reads a relay that demands authentication as refusing', () =>
    withRelay(
      (_, connection) =>
        Effect.gen(function* () {
          expect(yield* reasonOf(connection.query({ kinds: [0] }))).toBe('refused')
          expect((yield* connection.publish(request(alice, at))).message).toMatch(/^auth-required:/)
        }),
      { auth: true },
    ),
  )

  it.live('ends the connection on a message larger than it reads', () =>
    withRelay(
      (_, connection) =>
        Effect.map(reasonOf(connection.query({ kinds: [0] })), (reason) => expect(reason).toBe('oversize')),
      { noticeLength: 2048 },
      { ...options, maxFrameLength: 1024 },
    ),
  )

  it.live('fails what waits on a connection the relay drops', () =>
    withRelay(
      (_, connection) =>
        Effect.map(reasonOf(connection.query({ kinds: [0] })), (reason) => expect(reason).toBe('dropped')),
      { dropAfterRequests: 0 },
    ),
  )

  it.live('fails to connect to a relay that is not there, or that drops every connection', () =>
    Effect.gen(function* () {
      expect(yield* reasonOf(Effect.scoped(connectRelay('ws://127.0.0.1:9', options)))).toBe('unreachable')
      const relay = yield* Effect.promise(() => startTestRelay({ unreachable: true }))
      expect(yield* reasonOf(Effect.scoped(connectRelay(relay.url, options)))).toBe('unreachable')
      yield* Effect.promise(() => relay.close())
    }),
  )
})
