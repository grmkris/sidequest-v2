import { type Effect, Layer, ManagedRuntime, Schema } from 'effect'
import { HttpRouter, HttpServer } from 'effect/http'
import { apiRoutes } from '../src/Api.ts'
import { serverWorld } from './World.ts'

// The typed HTTP API as any client uses it: requests in, responses out, over the index and settlement on a local D1
// and a test chain. No request carries a cookie or a session: there is none. `run` reaches the services directly, for
// what only the server's own schedule does (recording the chain's facts), which no HTTP request can.

export const origin = 'https://sidequest.test'
export const release = '234a6c5'

/** What the API answered: its status and its JSON body (`null` for no content). */
export interface Reply {
  readonly status: number
  readonly body: unknown
}

type Services = Layer.Success<ReturnType<typeof serverWorld>['layer']>

export interface Api {
  readonly fetch: (path: string, init?: RequestInit) => Promise<Response>
  readonly run: <A, E>(effect: Effect.Effect<A, E, Services>) => Promise<A>
}

/** Run `test` against a fresh API: a new database and, unless `world` names another, no chain and no settlement. */
export const withApi = async (test: (api: Api) => Promise<void>, world = serverWorld().layer) => {
  const memoMap = Layer.makeMemoMapUnsafe()
  const runtime = ManagedRuntime.make(world, { memoMap })
  const { handler, dispose } = HttpRouter.toWebHandler(
    apiRoutes(release).pipe(Layer.provide(world), Layer.provide(HttpServer.layerServices)),
    { disableLogger: true, memoMap },
  )
  const fetch: Api['fetch'] = (path, init) => handler(new Request(`${origin}${path}`, init))
  try {
    await test({ fetch, run: (effect) => runtime.runPromise(effect) })
  } finally {
    await dispose()
    await runtime.dispose()
  }
}

/** A reply's body as `schema` reads it; a body it does not read fails the test. */
export const bodyOf = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, reply: Reply): S['Type'] =>
  Schema.decodeUnknownSync(schema)(reply.body)
