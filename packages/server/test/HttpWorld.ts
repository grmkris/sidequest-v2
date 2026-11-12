import { type AccountId, SessionView, SignInChallenge, UsdcOnArcTestnet } from '@sidequest/protocol'
import { type Effect, Layer, ManagedRuntime, Schema } from 'effect'
import { HttpRouter, HttpServer } from 'effect/http'
import { privateKeyToAccount } from 'viem/accounts'
import { apiRoutes } from '../src/Api.ts'
import { ada, ben, fakeArc, signInWorld } from './World.ts'

// The typed HTTP API as a browser on its own site uses it: JSON requests carrying the site's `Origin` and the session
// cookie, over the model in memory, its projections on a local D1 and a fake chain. `run` reaches the model directly,
// for what only the system does (the chain's `Record*` reports), which no HTTP request can.

export const origin = 'https://sidequest.test'
export const release = '234a6c5'

/** A third person, a stranger to the others' jobs. */
export const cy = privateKeyToAccount('0x3333333333333333333333333333333333333333333333333333333333333333')
export { ada, ben }
type Signer = typeof ada

/** What the API answered: its status and its JSON body (`null` for no content). */
export interface Reply {
  readonly status: number
  readonly body: unknown
}

/** Requests from one browser, as its person (or nobody). */
export interface Client {
  readonly get: (path: string) => Promise<Reply>
  readonly post: (path: string, body?: unknown) => Promise<Reply>
  readonly put: (path: string, body: unknown) => Promise<Reply>
}

/** A signed-in person: their account, their cookie, and their browser. */
export interface Person extends Client {
  readonly account: AccountId
  readonly cookie: string
}

type Model = Layer.Success<ReturnType<typeof signInWorld>['layer']>

export interface Api {
  readonly fetch: (path: string, init?: RequestInit) => Promise<Response>
  readonly anonymous: Client
  readonly signIn: (signer: Signer) => Promise<Person>
  readonly run: <A, E>(effect: Effect.Effect<A, E, Model>) => Promise<A>
}

const clientOf = (fetch: Api['fetch'], cookie?: string): Client => {
  const send = async (method: string, path: string, body?: unknown): Promise<Reply> => {
    const headers: Record<string, string> = cookie === undefined ? { origin } : { origin, cookie }
    const response = await fetch(
      path,
      body === undefined
        ? { method, headers }
        : { method, headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) },
    )
    const text = await response.text()
    const parsed: unknown = text === '' ? null : JSON.parse(text)
    return { status: response.status, body: parsed }
  }
  return {
    get: (path) => send('GET', path),
    post: (path, body) => send('POST', path, body),
    put: (path, body) => send('PUT', path, body),
  }
}

const signInWith = (fetch: Api['fetch']) => async (signer: Signer) => {
  const anonymous = clientOf(fetch)
  const challenge = await anonymous.post('/api/session/challenge', { address: signer.address })
  const { message } = Schema.decodeUnknownSync(SignInChallenge)(challenge.body)
  const verified = await fetch('/api/session/verify', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ message, signature: await signer.signMessage({ message }) }),
  })
  const cookie = (verified.headers.get('set-cookie') ?? '').split('; ')[0] ?? ''
  const { account } = Schema.decodeUnknownSync(SessionView)(await verified.json())
  return { ...clientOf(fetch, cookie), account, cookie }
}

/** Run `test` against a fresh API: a new model, a new database and, unless `world` names another, a fake chain. */
export const withApi = async (test: (api: Api) => Promise<void>, world = signInWorld(fakeArc().client).layer) => {
  const memoMap = Layer.makeMemoMapUnsafe()
  const runtime = ManagedRuntime.make(world, { memoMap })
  const { handler, dispose } = HttpRouter.toWebHandler(
    apiRoutes(release).pipe(Layer.provide(world), Layer.provide(HttpServer.layerServices)),
    { disableLogger: true, memoMap },
  )
  const fetch: Api['fetch'] = (path, init) => handler(new Request(`${origin}${path}`, init))
  try {
    await test({
      fetch,
      anonymous: clientOf(fetch),
      signIn: signInWith(fetch),
      run: (effect) => runtime.runPromise(effect),
    })
  } finally {
    await dispose()
    await runtime.dispose()
  }
}

/**
 * Read until `done` holds, at most a hundred times 20 ms apart: projections and views follow commands eventually.
 * Answers the last read either way, so the test's assertion reports what it saw.
 */
export const eventually = async (read: () => Promise<Reply>, done: (reply: Reply) => boolean): Promise<Reply> => {
  for (let attempt = 1; ; attempt += 1) {
    const reply = await read()
    if (done(reply) || attempt === 100) return reply
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** A reply's body as `schema` reads it; a body it does not read fails the test. */
export const bodyOf = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, reply: Reply): S['Type'] =>
  Schema.decodeUnknownSync(schema)(reply.body)

/** The `id` an endpoint that creates something answered with. */
export const createdId = <A>(id: Schema.Decoder<A>, reply: Reply): A => bodyOf(Schema.Struct({ id }), reply).id

/** Now and later, in Unix seconds. */
export const inSeconds = (seconds: number) => Math.floor(Date.now() / 1000) + seconds
const day = 24 * 60 * 60

/** Terms a bidder offers: a logo in USDC on Arc testnet, due in 30 days. */
export const terms = (amount = '250000000', deliverables: ReadonlyArray<string> = ['SVG logo']) => ({
  title: 'A logo for a café',
  deliverables,
  amount,
  asset: UsdcOnArcTestnet.id,
  network: UsdcOnArcTestnet.network,
  deliveryDeadline: inSeconds(30 * day),
  reviewWindowSeconds: 3 * day,
  disputeWindowSeconds: 2 * day,
  arbitrationWindowSeconds: 7 * day,
  rail: 'escrow',
})

/** A request a buyer posts, open for a week. */
export const request = (title = 'A logo for my café') => ({
  title,
  description: 'Warm, hand-drawn, works small.',
  expiresAt: inSeconds(7 * day),
})
