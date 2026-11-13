import { expect } from 'bun:test'
import * as Cloudflare from '@alchemy.run/cloudflare'
import {
  AccountRef,
  AgentId,
  ConnectDecision,
  IssuedAgentToken,
  ListingId,
  Person,
  SessionView,
  Status,
} from '@sidequest/protocol'
import * as Alchemy from 'alchemy'
import * as Test from 'alchemy/Test/Bun'
import { Clock, DateTime, Effect, Schema } from 'effect'
import { Base64Url } from 'effect/encoding'
import { McpClient, McpProtocol } from 'effect/ai'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { apiPolicy, documentPolicy } from '../EdgeSecurity.ts'
import { compatibility, edgeWorker, sidequestWorkers } from '../Stack.ts'
import { headlessChromium } from './ChromiumWorld.ts'
import WakeWorkerLive, { millis, sleeps, WakeWorker } from './WakeWorker.ts'
import {
  findsPublishedListing,
  foldsPublishedJob,
  keepsLocalKeyAsBackup,
  linksWalletWithExtension,
  negotiatesOnEvents,
  pipesToRelay,
  refusesForeignPipes,
  rendersRequestsOnTheServer,
} from './NostrJourneys.ts'
import { startTestRelay } from '../../test/TestRelay.ts'
import { talksInARoom } from './RoomJourneys.ts'
import {
  browserOf,
  createdBy,
  Inbox,
  kindsIn,
  Messages,
  negotiate,
  postJson,
  Rooms,
  signedIn,
  signedProfile,
  signIn,
  until,
} from './EdgeWorld.ts'

// `test:native` builds the website with this release before the test runs (package.json).
const release = 'acceptance'
const forgedCorrelation = 'forged-by-the-client'
// The stage's default inbox relay: a NIP-17 inbox that hands gift wraps only to their authenticated recipients.
const inboxRelay = await startTestRelay({ wrapsForRecipients: true })
// The API reaches Arc only to check a contract account's signature. Nothing listens on the discard port, so a key's
// sign-in passes only if it never calls the chain, and the test needs no network.
const unreachableRpc = 'http://127.0.0.1:9'

// The production Workers around the built website, run in workerd. Website.Foldkit's dev mode runs Vite in Node, which
// cannot prove the deployed Worker, so the website is the SSR artifact itself. A second edge in front of a Worker that
// answers with the headers it received shows what the edge forwards to the API.
const Stack = Alchemy.Stack(
  'SidequestLocalAcceptance',
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const { url } = yield* sidequestWorkers(
      release,
      (api) =>
        Cloudflare.Worker('SidequestWebsite', {
          main: 'apps/web/dist/server/fetch.js',
          assets: { directory: 'apps/web/dist/client' },
          compatibility,
          env: { API: api, SIDEQUEST_DEFAULT_INBOX_RELAYS: inboxRelay.url },
        }),
      unreachableRpc,
      {},
      {},
      // The relay pipe may reach the test relay on 127.0.0.1; a deployed stage never passes this.
      'local',
    )
    const received = yield* Cloudflare.Worker('ReceivedHeaders', {
      script: 'export default { fetch: (request) => Response.json(Object.fromEntries(request.headers)) }',
      compatibility,
    })
    const probe = yield* Cloudflare.Worker('HeaderProbeEdge', {
      ...edgeWorker,
      env: { API: received, WEBSITE: received },
    })
    const wakes = yield* WakeWorker.pipe(Effect.provide(WakeWorkerLive))
    return { url, probeUrl: probe.url.as<string>(), wakesUrl: wakes.url.as<string>() }
  }),
)

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Alchemy.localState(),
  stage: 'local-native',
  dev: true,
  sidecar: { omitEnv: ['CLOUDFLARE_'] },
})

// The first requests may meet a Worker that is still starting; wait until the edge serves both routes.
const stack = beforeAll(
  deploy(Stack).pipe(
    Effect.tap(({ url }) => Test.getWhenReady(`${url}/api/status`)),
    Effect.tap(({ url }) => Test.getWhenReady(url)),
    Effect.provide(FetchHttpClient.layer),
  ),
  { timeout: 120000 },
)
afterAll(destroy(Stack).pipe(Effect.ensuring(Effect.promise(() => inboxRelay.close()))), { timeout: 60000 })

test(
  'serves the typed status with the release and the API security headers through the edge',
  Effect.gen(function* () {
    const { url } = yield* stack
    const response = yield* HttpClient.get(`${url}/api/status`)
    expect(response.status).toBe(200)
    const status = yield* Effect.flatMap(response.json, Schema.decodeUnknownEffect(Status))
    expect(status.release).toBe(release)
    expect(response.headers['content-security-policy']).toBe(apiPolicy)
    expect(response.headers['x-content-type-options']).toBe('nosniff')
  }).pipe(Effect.provide(FetchHttpClient.layer)),
  { timeout: 30000 },
)

test(
  'serves the server-rendered document with its release and the document security headers through the edge',
  Effect.gen(function* () {
    const { url } = yield* stack
    const response = yield* HttpClient.get(url, { headers: { accept: 'text/html' } })
    expect(response.status).toBe(200)
    expect(response.headers['content-type']).toContain('text/html')
    expect(yield* response.text).toContain(`Release ${release}`)
    expect(response.headers['content-security-policy']).toBe(documentPolicy)
    expect(response.headers['strict-transport-security']).toBe('max-age=31536000')
  }).pipe(Effect.provide(FetchHttpClient.layer)),
  { timeout: 30000 },
)

test(
  'wakes a durable workflow on time after every sleep, as the settlement sagas need on Durable Objects',
  Effect.gen(function* () {
    const { wakesUrl } = yield* stack
    const started = yield* Clock.currentTimeMillis
    // A new run each time: the local Durable Objects outlive a run of this test, and the same id finds the old run.
    const { executionId } = yield* until(
      HttpClient.get(`${wakesUrl}/start/wakes-${started}`),
      Schema.Struct({ executionId: Schema.String }),
    )
    // Each wake-up is the run's progress: a clock that fired, or a run that sleeps again, is not a retry of the one
    // before. Counted as retries, the wakes backed off 5 s, 10 s, 20 s, ... and this run took over ten minutes.
    const done = yield* until(
      HttpClient.get(`${wakesUrl}/status/${executionId}`),
      Schema.Struct({ completed: Schema.Boolean, result: Schema.optional(Schema.Number) }),
      (status) => status.completed,
    )
    expect(done.result).toBe(sleeps)
    expect((yield* Clock.currentTimeMillis) - started).toBeLessThan(sleeps * millis + 5000)
  }).pipe(Effect.provide(FetchHttpClient.layer)),
  { timeout: 60000 },
)

test(
  'accepts a signed profile through the edge with no session, and serves it as what the index knows of the key',
  Effect.gen(function* () {
    const { url } = yield* stack
    const { event, pubkey } = signedProfile('Acceptance')
    const published = yield* postJson(`${url}/api/events`, event)
    expect(yield* published.json).toEqual({ id: event.id, status: 'stored' })
    const person = yield* until(HttpClient.get(`${url}/api/people/${pubkey}`), Person)
    expect(person.profile).toMatchObject({ name: 'Acceptance', event: event.id })
  }).pipe(Effect.provide(FetchHttpClient.layer)),
  { timeout: 30000 },
)

test(
  'pipes a page to a Nostr relay through the edge: a subscription to its end, and an event published and read back',
  Effect.flatMap(stack, ({ url }) => pipesToRelay(url)).pipe(Effect.scoped),
  { timeout: 30000 },
)

test(
  'refuses a pipe from another origin with 403 and to a relay the policy does not allow with 400',
  Effect.flatMap(stack, ({ url }) => refusesForeignPipes(url)).pipe(Effect.scoped),
  { timeout: 30000 },
)

test(
  'folds a job from a request and a proposal published through the edge: proposed',
  Effect.flatMap(stack, ({ url }) => foldsPublishedJob(url)).pipe(Effect.provide(FetchHttpClient.layer)),
  { timeout: 30000 },
)

test(
  'answers an unknown API path with 404',
  Effect.gen(function* () {
    const { url } = yield* stack
    const response = yield* HttpClient.get(`${url}/api/nope`)
    expect(response.status).toBe(404)
  }).pipe(Effect.provide(FetchHttpClient.layer)),
  { timeout: 30000 },
)

test(
  'replaces a client correlation id and drops other client sidequest headers before the API sees the request',
  Effect.gen(function* () {
    const { probeUrl } = yield* stack
    const response = yield* HttpClient.get(`${probeUrl}/api/status`, {
      headers: { 'x-sidequest-correlation-id': forgedCorrelation, 'x-sidequest-account': 'forged' },
    })
    expect(response.status).toBe(200)
    const received = yield* Effect.flatMap(
      response.json,
      Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.String)),
    )
    expect(received['x-sidequest-correlation-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
    expect(received['x-sidequest-account']).toBeUndefined()
  }).pipe(Effect.provide(FetchHttpClient.layer)),
  { timeout: 30000 },
)

test(
  'hydrates the page in headless Chromium without errors and shows the title and release',
  Effect.scoped(
    Effect.gen(function* () {
      const { url } = yield* stack
      const browser = yield* headlessChromium
      const page = yield* Effect.promise(() => browser.newPage())
      const problems: Array<string> = []
      page.on('pageerror', (error) => problems.push(error.message))
      page.on('console', (message) => {
        if (message.type() === 'error') problems.push(message.text())
      })
      const document = yield* Effect.promise(() => page.goto(url, { waitUntil: 'networkidle' }))
      expect(document?.status()).toBe(200)
      // The server stamps the root it rendered; Foldkit removes the stamp when it adopts that root in the browser.
      expect(yield* Effect.promise(() => document?.text() ?? Promise.resolve(''))).toContain('data-foldkit-app')
      yield* Effect.promise(() =>
        page.waitForFunction(() => window.document.querySelector('[data-foldkit-app]') === null, undefined, {
          timeout: 10000,
        }),
      )
      const text = yield* Effect.promise(() => page.locator('body').innerText())
      expect(text).toContain('Get work done by people and their agents')
      expect(text).toContain(`Release ${release}`)
      expect(problems).toEqual([])
    }),
  ),
  { timeout: 60000 },
)

test(
  'signs a wallet in through the edge with a __Host- session cookie, reads the session, signs out, and refuses a replay',
  Effect.gen(function* () {
    const { url } = yield* stack
    const wallet = privateKeyToAccount(generatePrivateKey())
    const { message, signature, response } = yield* signIn(url, wallet)
    expect(response.status).toBe(200)
    const session = yield* Effect.flatMap(response.json, Schema.decodeUnknownEffect(SessionView))
    expect(session.account).toMatch(/^account_/)
    expect(session.wallet).toBe(AccountRef.make(`eip155:5042002:${wallet.address}`))
    const [cookie = '', ...attributes] = (response.headers['set-cookie'] ?? '').split('; ')
    expect(cookie).toMatch(/^__Host-sidequest-session=[0-9a-f]{64}$/)
    expect(attributes.toSorted()).toEqual(['HttpOnly', 'Max-Age=604800', 'Path=/', 'SameSite=Lax', 'Secure'])

    const current = yield* HttpClient.get(`${url}/api/session`, { headers: { cookie } })
    expect(current.status).toBe(200)
    expect(yield* Effect.flatMap(current.json, Schema.decodeUnknownEffect(SessionView))).toEqual(session)

    // The same wallet signs in to the same account.
    const again = yield* signIn(url, wallet)
    expect(yield* Effect.flatMap(again.response.json, Schema.decodeUnknownEffect(SessionView))).toMatchObject({
      account: session.account,
    })

    // A request with no body proves where it comes from with `Origin`, as a browser on the site sends it.
    expect((yield* HttpClient.post(`${url}/api/session/sign-out`, { headers: { cookie, origin: url } })).status).toBe(
      204,
    )
    expect((yield* HttpClient.get(`${url}/api/session`, { headers: { cookie } })).status).toBe(401)

    const replayed = yield* postJson(`${url}/api/session/verify`, { message, signature })
    expect(replayed.status).toBe(401)
    expect(yield* replayed.json).toEqual({ _tag: 'SignInRefused', reason: 'unknown_nonce' })
  }).pipe(Effect.provide(FetchHttpClient.layer)),
  { timeout: 60000 },
)

test(
  'runs the off-chain hire for two wallets through the edge: Durable Objects, D1 projections and policies together',
  Effect.gen(function* () {
    const { url } = yield* stack
    const ada = yield* signedIn(url)
    const ben = yield* signedIn(url)
    const { listing, job, first, second } = yield* negotiate(ada, ben)
    expect((yield* ada.post(`/api/jobs/${job}/acceptance`, first)).status).toBe(409)
    expect((yield* ada.post(`/api/jobs/${job}/acceptance`, second)).status).toBe(204)
    // RoomOpening opened the negotiation room on the first proposal and the engagement room on the award.
    const { rooms } = yield* until(ben.get(`/api/jobs/${job}/rooms`), Rooms, (shown) => shown.rooms.length === 2)
    const [negotiation] = rooms
    expect(rooms.map(({ kind }) => kind)).toEqual(['negotiation', 'engagement'])
    expect(
      (yield* ada.post(`/api/rooms/${negotiation?.id}/messages`, { text: 'Thank you!', key: 'ada-1' })).status,
    ).toBe(204)
    const { messages } = yield* until(
      ben.get(`/api/rooms/${negotiation?.id}/messages`),
      Messages,
      (read) => read.messages.length === 1,
    )
    expect(messages).toEqual([{ seq: 1, author: ada.account, text: 'Thank you!' }])
    const searched = yield* until(
      ada.get('/api/listings?q=logo'),
      Schema.Struct({ items: Schema.Array(Schema.Struct({ id: ListingId })) }),
      (page) => page.items.length > 0,
    )
    expect(searched.items.map(({ id }) => id)).toContain(listing)
    const adas = yield* until(ada.get('/api/inbox'), Inbox, (inbox) => inbox.items.length === 2)
    expect(kindsIn(adas)).toEqual(['proposal_submitted', 'proposal_submitted'])
    const bens = yield* until(ben.get('/api/inbox'), Inbox, (inbox) => inbox.items.length === 3)
    expect(kindsIn(bens).toSorted()).toEqual(['change_requested', 'message_posted', 'proposal_accepted'])
  }).pipe(Effect.provide(FetchHttpClient.layer)),
  { timeout: 90000 },
)

test(
  'serves MCP through the edge to an agent with a bearer token, and challenges a request without one',
  Effect.gen(function* () {
    const { url } = yield* stack
    const operator = yield* signedIn(url)
    const agent = yield* createdBy(operator.post('/api/agents', { name: 'Scout' }), AgentId)
    const expiresAt = Math.floor(DateTime.toEpochMillis(yield* DateTime.now) / 1000) + 3600
    expect((yield* operator.put(`/api/agents/${agent}/grant`, { scopes: ['discuss'], expiresAt })).status).toBe(204)
    const issued = yield* operator.post(`/api/agents/${agent}/tokens`, {})
    const { token } = yield* Effect.flatMap(issued.json, Schema.decodeUnknownEffect(IssuedAgentToken))

    const bare = yield* postJson(`${url}/mcp`, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    expect(bare.status).toBe(401)
    expect(bare.headers['www-authenticate']).toBe(
      `Bearer realm="sidequest", resource_metadata="${url}/.well-known/oauth-protected-resource/mcp"`,
    )

    const client = yield* McpClient.make({ name: 'acceptance', version: '1' }).pipe(
      Effect.provideServiceEffect(
        McpClient.Transport,
        McpClient.http({
          url: `${url}/mcp`,
          protocol: McpProtocol.v2026_07_28,
          headers: { authorization: `Bearer ${token}` },
        }),
      ),
    )
    expect(client.serverInfo?.name).toBe('sidequest')
    const tools = yield* client.listTools()
    expect(tools.map(({ name }) => name)).toContain('whoami')
    const whoami = tools.find(({ name }) => name === 'whoami')
    if (whoami === undefined) return yield* Effect.die(new Error('No whoami tool'))
    const result = yield* client.callTool({ tool: whoami, arguments: {} })
    expect(result.structuredContent).toMatchObject({
      account: operator.account,
      agent: { id: agent, scopes: ['discuss'], grantExpiresAt: expiresAt },
    })
  }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
  { timeout: 60000 },
)

test(
  'links the wallet with a NIP-07 extension, publishing no profile over theirs, and the index shows it verified',
  Effect.scoped(Effect.flatMap(stack, ({ url }) => linksWalletWithExtension(url))).pipe(
    Effect.provide(FetchHttpClient.layer),
  ),
  { timeout: 120000 },
)

test(
  'makes a key in the browser behind a confirmed backup, unlocks it after a reload, and keeps no secret in storage',
  Effect.scoped(Effect.flatMap(stack, ({ url }) => keepsLocalKeyAsBackup(url))).pipe(
    Effect.provide(FetchHttpClient.layer),
  ),
  { timeout: 120000 },
)

test(
  'negotiates on signed events in two browsers: a request, a proposal and its revision, the buyer’s accept',
  Effect.scoped(Effect.flatMap(stack, ({ url }) => negotiatesOnEvents(url))).pipe(
    Effect.provide(FetchHttpClient.layer),
  ),
  { timeout: 180000 },
)

test(
  'two people talk in a job’s encrypted room through the relay pipe; a private proposal becomes fundable on consent',
  Effect.scoped(Effect.flatMap(stack, ({ url }) => talksInARoom(url, inboxRelay))).pipe(
    Effect.provide(FetchHttpClient.layer),
  ),
  { timeout: 300000 },
)

test(
  'publishes a listing with a NIP-07 key, and a visitor finds it by searching',
  Effect.scoped(Effect.flatMap(stack, ({ url }) => findsPublishedListing(url))),
  { timeout: 120000 },
)

test(
  'renders the home page and a job page with a published request in the HTML, readable without JavaScript',
  Effect.flatMap(stack, ({ url }) => rendersRequestsOnTheServer(url)).pipe(Effect.provide(FetchHttpClient.layer)),
  { timeout: 60000 },
)

test(
  'connects an MCP client over OAuth through the edge, and serves it as a 2025-11-25 client without a session',
  Effect.gen(function* () {
    const { url } = yield* stack
    const person = yield* signedIn(url)
    const agent = yield* createdBy(person.post('/api/agents', { name: 'Scout' }), AgentId)
    const expiresAt = Math.floor(DateTime.toEpochMillis(yield* DateTime.now) / 1000) + 3600
    yield* person.put(`/api/agents/${agent}/grant`, { scopes: ['discuss'], expiresAt })
    const redirect = 'http://127.0.0.1:9/callback'
    const registered = yield* postJson(`${url}/oauth/register`, { redirect_uris: [redirect] })
    const Registered = Schema.Struct({ client_id: Schema.String })
    const { client_id: client } = yield* Effect.flatMap(registered.json, Schema.decodeUnknownEffect(Registered))
    // PKCE from Web Crypto here, never the server's code: a verifier and its S256 challenge.
    const verifier = generatePrivateKey().slice(2)
    const digest = yield* Effect.promise(() => crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
    const query = new URLSearchParams({ response_type: 'code', client_id: client, redirect_uri: redirect, state: 's1' })
    query.set('code_challenge', Base64Url.encode(new Uint8Array(digest)))
    query.set('code_challenge_method', 'S256')
    const authorized = yield* HttpClient.get(`${url}/oauth/authorize?${query.toString()}`).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: 'manual' }),
    )
    const consentPage = authorized.headers['location'] ?? ''
    expect(consentPage).toMatch(/^\/connect\/connect_[0-9A-HJKMNP-TV-Z]{26}$/u)
    expect((yield* HttpClient.get(`${url}${consentPage}`, { headers: { accept: 'text/html' } })).status).toBe(200)
    // The person allows it from the browser that opened the request: their session and the request's binding cookie.
    const binding = (authorized.headers['set-cookie'] ?? '').split('; ')[0] ?? ''
    const allowed = yield* browserOf(url, `${person.cookie}; ${binding}`).post(`/api${consentPage}/allow`, { agent })
    const { redirect: back } = yield* Effect.flatMap(allowed.json, Schema.decodeUnknownEffect(ConnectDecision))
    const answered = new URL(back).searchParams
    expect([answered.get('state'), answered.get('iss')]).toEqual(['s1', url])
    const form = { grant_type: 'authorization_code', code: answered.get('code') ?? '', code_verifier: verifier }
    const tokenRequest = HttpClientRequest.post(`${url}/oauth/token`).pipe(
      HttpClientRequest.bodyUrlParams({ ...form, redirect_uri: redirect, client_id: client }),
    )
    const exchanged = yield* HttpClient.execute(tokenRequest)
    const Tokens = Schema.Struct({ access_token: Schema.String })
    const { access_token: token } = yield* Effect.flatMap(exchanged.json, Schema.decodeUnknownEffect(Tokens))
    const accept = 'application/json, text/event-stream'
    const mcp = (body: Record<string, unknown>, version: Record<string, string> = {}) =>
      HttpClient.execute(
        HttpClientRequest.post(`${url}/mcp`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ jsonrpc: '2.0', id: 1, ...body }),
          HttpClientRequest.setHeaders({ authorization: `Bearer ${token}`, accept, ...version }),
        ),
      )
    const params = { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'acceptance', version: '1' } }
    const initialized = yield* mcp({ method: 'initialize', params })
    expect(initialized.headers['mcp-session-id']).toBeUndefined()
    expect(yield* initialized.json).toMatchObject({ result: { protocolVersion: '2025-11-25' } })
    const whoami = { method: 'tools/call', params: { name: 'whoami', arguments: {} } }
    const called = yield* mcp(whoami, { 'mcp-protocol-version': '2025-11-25' })
    expect(yield* called.json).toMatchObject({ result: { structuredContent: { agent: { id: agent } } } })
  }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
  { timeout: 60000 },
)
