import { get } from 'node:http'
import { Effect, Option, Queue, Schema } from 'effect'

// A page's WebSocket through the edge's relay pipe, for the native acceptance test: what it sends, what reaches it,
// and how it closes.

/** What the page's socket saw: a text message, or its close and the code it closed with. */
type Seen = { readonly text: string } | { readonly closed: number }

const RelayFrame = Schema.fromJsonString(Schema.NonEmptyArray(Schema.Unknown))
const decodeFrame = Schema.decodeUnknownOption(RelayFrame)

const pipeAddress = (url: string, relay: string) => `${url}/relay?url=${encodeURIComponent(relay)}`

/**
 * A WebSocket through the pipe at `url` to `relay`, opened as a page of the site opens it (with `headers` too), for
 * the scope: send a frame or raw text, read the next relay frame of a type (skipping others), or wait for the close
 * and its code. Each wait is bounded at 10 s.
 */
export const pipeTo = (url: string, relay: string, headers: Readonly<Record<string, string>> = {}) =>
  Effect.gen(function* () {
    const seen = yield* Queue.unbounded<Seen>()
    const socket = yield* Effect.acquireRelease(
      Effect.suspend(() => {
        // Bun's WebSocket takes request headers, as a browser's sets `Origin`; the DOM types the repository compiles
        // with know only its `protocols` overload, so the constructor is called through `Reflect`.
        const address = pipeAddress(url.replace(/^http/u, 'ws'), relay)
        const created: unknown = Reflect.construct(WebSocket, [address, { headers: { origin: url, ...headers } }])
        if (!(created instanceof WebSocket)) return Effect.die('Bun did not construct a WebSocket')
        created.addEventListener('message', (event) => void Queue.offerUnsafe(seen, { text: String(event.data) }))
        created.addEventListener('close', (event) => void Queue.offerUnsafe(seen, { closed: event.code }))
        return Effect.succeed(created)
      }),
      (opened) => Effect.sync(() => opened.close()),
    )
    yield* Effect.callback<void>((resume) => {
      if (socket.readyState === WebSocket.OPEN) return resume(Effect.void)
      socket.addEventListener('open', () => resume(Effect.void))
    }).pipe(Effect.timeout('10 seconds'))
    const next = <A>(pick: (item: Seen) => A | undefined) =>
      Effect.gen(function* () {
        for (;;) {
          const picked = pick(yield* Queue.take(seen))
          if (picked !== undefined) return picked
        }
      }).pipe(Effect.timeout('10 seconds'))
    return {
      send: (frame: ReadonlyArray<unknown>) => Effect.sync(() => socket.send(JSON.stringify(frame))),
      sendText: (text: string) => Effect.sync(() => socket.send(text)),
      /** The next frame of `type` the relay sent. */
      frame: (type: string) =>
        next((item) => {
          if (!('text' in item)) return undefined
          const frame = decodeFrame(item.text)
          return Option.isSome(frame) && frame.value[0] === type ? frame.value : undefined
        }),
      /** The code the pipe closed the socket with. */
      closed: next((item) => ('closed' in item ? item.closed : undefined)),
    }
  })

/**
 * The status an upgrade request to the pipe is answered with, from `origin`. Through `node:http`, because `fetch`
 * refuses to send `Upgrade`; a 101 is reported as such and its socket closed at once.
 */
export const upgradeStatus = (url: string, relay: string, origin: string) =>
  Effect.callback<number>((resume) => {
    const request = get(pipeAddress(url, relay), {
      headers: {
        origin,
        upgrade: 'websocket',
        connection: 'Upgrade',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      },
    })
    request.on('response', (response) => {
      response.resume()
      resume(Effect.succeed(response.statusCode ?? 0))
    })
    request.on('upgrade', (_, socket) => {
      socket.destroy()
      resume(Effect.succeed(101))
    })
    request.on('error', () => resume(Effect.die('the edge did not answer the upgrade request')))
  }).pipe(Effect.timeout('10 seconds'))
