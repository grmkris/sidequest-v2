import { expect } from 'bun:test'
import * as Cloudflare from '@alchemy.run/cloudflare'
import {
  type AccountId,
  AccountRef,
  AgentId,
  Cursor,
  InboxEntry,
  IssuedAgentToken,
  JobId,
  JobView,
  ListingId,
  Message,
  ProposalId,
  type ProposalRef,
  RoomRef,
  SessionView,
  SignInChallenge,
  Status,
  UsdcOnArcTestnet,
} from '@sidequest/protocol'
import * as Alchemy from 'alchemy'
import * as Test from 'alchemy/Test/Bun'
import { DateTime, Effect, Schedule, Schema } from 'effect'
import { McpClient, McpProtocol } from 'effect/ai'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import * as HttpClient from 'effect/http/HttpClient'
import type * as HttpClientError from 'effect/http/HttpClientError'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'
import type * as HttpClientResponse from 'effect/http/HttpClientResponse'
import { type Browser as Chromium, type BrowserContext, chromium, type Page } from 'playwright'
import { isHex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { apiPolicy, documentPolicy } from '../EdgeSecurity.ts'
import { compatibility, edgeWorker, sidequestWorkers } from '../Stack.ts'

// `test:native` builds the website with this release before the test runs (package.json).
const release = 'acceptance'
const forgedCorrelation = 'forged-by-the-client'
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
          env: { API: api },
        }),
      unreachableRpc,
    )
    const received = yield* Cloudflare.Worker('ReceivedHeaders', {
      script: 'export default { fetch: (request) => Response.json(Object.fromEntries(request.headers)) }',
      compatibility,
    })
    const probe = yield* Cloudflare.Worker('HeaderProbeEdge', {
      ...edgeWorker,
      env: { API: received, WEBSITE: received },
    })
    return { url, probeUrl: probe.url.as<string>() }
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
afterAll(destroy(Stack), { timeout: 60000 })

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

/** A headless Chromium for one test, closed when the test's scope ends. */
const headlessChromium = Effect.acquireRelease(
  Effect.promise(() => chromium.launch({ headless: true })),
  (opened) => Effect.promise(() => opened.close()),
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

const postJson = (url: string, body: unknown) =>
  HttpClient.execute(HttpClientRequest.post(url).pipe(HttpClientRequest.bodyJsonUnsafe(body)))

/** Sign a generated key in through the edge: ask for a challenge, sign it, send it back. */
const signIn = (url: string, wallet: ReturnType<typeof privateKeyToAccount>) =>
  Effect.gen(function* () {
    const challenge = yield* postJson(`${url}/api/session/challenge`, { address: wallet.address })
    expect(challenge.status).toBe(200)
    const { message } = yield* Effect.flatMap(challenge.json, Schema.decodeUnknownEffect(SignInChallenge))
    const signature = yield* Effect.promise(() => wallet.signMessage({ message }))
    return { message, signature, response: yield* postJson(`${url}/api/session/verify`, { message, signature }) }
  })

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

/** One person's requests through the edge: JSON, from the site's origin, with their session cookie. */
const browserOf = (url: string, cookie: string) => {
  const send = (request: HttpClientRequest.HttpClientRequest, body?: unknown) =>
    HttpClient.execute(
      (body === undefined ? request : HttpClientRequest.bodyJsonUnsafe(request, body)).pipe(
        HttpClientRequest.setHeaders({ cookie, origin: url }),
      ),
    )
  return {
    get: (path: string) => send(HttpClientRequest.get(`${url}${path}`)),
    post: (path: string, body?: unknown) => send(HttpClientRequest.post(`${url}${path}`), body),
    put: (path: string, body: unknown) => send(HttpClientRequest.put(`${url}${path}`), body),
  }
}
type Browser = ReturnType<typeof browserOf> & { readonly account: AccountId; readonly cookie: string }

/** Sign a fresh wallet in and keep its session cookie. */
const signedIn = (url: string) =>
  Effect.gen(function* () {
    const { response } = yield* signIn(url, privateKeyToAccount(generatePrivateKey()))
    const cookie = (response.headers['set-cookie'] ?? '').split('; ')[0] ?? ''
    const { account } = yield* Effect.flatMap(response.json, Schema.decodeUnknownEffect(SessionView))
    const browser: Browser = { ...browserOf(url, cookie), account, cookie }
    return browser
  })

class NotYet extends Schema.TaggedError<NotYet>()('NotYet', {}) {}

/**
 * Read until the answer decodes and `done` holds: Durable Objects commit at once, but views and D1 projections follow
 * eventually. A bounded retry, every 100 ms for at most 20 seconds, never a fixed sleep.
 */
const until = <A>(
  read: Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError, HttpClient.HttpClient>,
  schema: Schema.Decoder<A>,
  done: (value: A) => boolean = () => true,
) =>
  read.pipe(
    Effect.flatMap((response) => response.json),
    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
    Effect.flatMap((value) => (done(value) ? Effect.succeed(value) : Effect.fail(new NotYet()))),
    Effect.retry({ schedule: Schedule.spaced('100 millis'), times: 200 }),
  )

/** The id a command that creates something answered with; a command is sent once, never retried. */
const createdBy = <A>(
  send: Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError, HttpClient.HttpClient>,
  id: Schema.Decoder<A>,
) =>
  send.pipe(
    Effect.flatMap((response) => response.json),
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ id }))),
    Effect.map((created) => created.id),
  )
const day = 86_400
const offer = (amount: string) => ({
  title: 'A logo',
  deliverables: ['SVG logo'],
  amount,
  asset: UsdcOnArcTestnet.id,
  network: UsdcOnArcTestnet.network,
  deliveryDeadline: Math.floor(Date.now() / 1000) + 30 * day,
  reviewWindowSeconds: 3 * day,
  disputeWindowSeconds: 2 * day,
  arbitrationWindowSeconds: 7 * day,
  rail: 'escrow',
})

/** The versions the buyer's view of `job` names, once it holds `count`. */
const proposalsFor = (buyer: Browser, job: string, count: number) =>
  until(
    buyer.get(`/api/jobs/${job}`),
    JobView,
    (shown) => shown.audience === 'buyer' && shown.view.proposals.length === count,
  ).pipe(
    Effect.map((shown): ReadonlyArray<ProposalRef> =>
      shown.audience === 'buyer'
        ? shown.view.proposals.map(({ bidder, version, termsDigest }) => ({ bidder, version, termsDigest }))
        : [],
    ),
  )

const Rooms = Schema.Struct({ rooms: Schema.Array(RoomRef) })
const Messages = Schema.Struct({ messages: Schema.Array(Message) })
const Inbox = Schema.Struct({ items: Schema.Array(InboxEntry), next: Cursor })
const kindsIn = (inbox: typeof Inbox.Type) => inbox.items.map(({ kind }) => kind)

/** Ben offers logos, Ada posts a request; Ben proposes, Ada asks for a change, Ben proposes again. */
const negotiate = (ada: Browser, ben: Browser) =>
  Effect.gen(function* () {
    const listing = yield* createdBy(
      ben.post('/api/listings', { title: 'Logos', description: 'By hand.', tags: ['logo'] }),
      ListingId,
    )
    const now = Math.floor(DateTime.toEpochMillis(yield* DateTime.now) / 1000)
    const posted = { title: 'A logo for my café', description: 'Warm.', expiresAt: now + 7 * day }
    const job = yield* createdBy(ada.post('/api/jobs', posted), JobId)
    yield* createdBy(ben.post(`/api/jobs/${job}/proposals`, { terms: offer('250000000') }), ProposalId)
    const [v1] = yield* proposalsFor(ada, job, 1)
    expect((yield* ada.post(`/api/jobs/${job}/change-requests`, v1)).status).toBe(204)
    yield* createdBy(ben.post(`/api/jobs/${job}/proposals`, { previous: 1, terms: offer('300000000') }), ProposalId)
    const [first, second] = yield* proposalsFor(ada, job, 2)
    return { listing, job, first, second }
  })

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
    expect(bare.headers['www-authenticate']).toBe('Bearer realm="sidequest"')

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

/** A browser context whose page has a wallet: `window.ethereum`, an EIP-1193 provider backed by a key in this process.
 * The page's CSP forbids inline script, so the provider is installed with Playwright's init script, which the browser
 * evaluates outside the page's CSP, and each request crosses to Node through an exposed function. */
const walletContext = (browser: Chromium) =>
  Effect.gen(function* () {
    const wallet = privateKeyToAccount(generatePrivateKey())
    const context = yield* Effect.promise(() => browser.newContext({ locale: 'en-US' }))
    yield* Effect.promise(() =>
      context.exposeFunction('__sidequestWallet', async (method: string, params: ReadonlyArray<unknown>) => {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [wallet.address]
        if (method === 'eth_chainId') return '0x4cef52'
        const [message] = params
        if (method === 'personal_sign' && typeof message === 'string' && isHex(message))
          return wallet.signMessage({ message: { raw: message } })
        throw Object.assign(new Error(`The test wallet does not answer ${method}`), { code: 4200 })
      }),
    )
    yield* Effect.promise(() =>
      context.addInitScript({
        content:
          'window.ethereum = { request: ({ method, params }) => window.__sidequestWallet(method, params ?? []) }',
      }),
    )
    return { wallet, context }
  })

/** A page that records every error the browser reports, CSP violations included, and is hydrated before use. */
const openPage = (context: BrowserContext, url: string) =>
  Effect.gen(function* () {
    const page = yield* Effect.promise(() => context.newPage())
    const problems: Array<string> = []
    page.on('pageerror', (error) => problems.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') problems.push(message.text())
    })
    yield* Effect.promise(() => page.goto(url, { waitUntil: 'networkidle' }))
    yield* hydrated(page)
    return { page, problems }
  })

const hydrated = (page: Page) =>
  Effect.promise(() =>
    page.waitForFunction(() => window.document.querySelector('[data-foldkit-app]') === null, undefined, {
      timeout: 10000,
    }),
  )

/** Open `target` in `page` and wait until it hydrated; the paths of the API reads the page made meanwhile, data or
 * session alike. A page hydrated from the server's data makes none of the reads it rendered. */
const apiReadsDuring = (page: Page, target: string) =>
  Effect.gen(function* () {
    const reads: Array<string> = []
    const record = (request: { readonly method: () => string; readonly url: () => string }) => {
      const path = new URL(request.url()).pathname
      if (request.method() === 'GET' && path.startsWith('/api/')) reads.push(path)
    }
    page.on('request', record)
    yield* Effect.promise(() => page.goto(target, { waitUntil: 'networkidle' }))
    yield* hydrated(page)
    page.off('request', record)
    return reads
  })

/** Reload until `text` shows: the open requests come from a D1 projection, which follows the job eventually. A bounded
 * retry on what the page shows, never a fixed sleep. */
const reloadUntilShown = (page: Page, text: string) =>
  Effect.tryPromise(async () => {
    await page.reload({ waitUntil: 'networkidle' })
    await page.getByText(text).first().waitFor({ timeout: 1000 })
  }).pipe(Effect.retry({ times: 20 }))

test(
  'signs in with an injected wallet, posts a request as the buyer, and shows it to another visitor on the home page',
  Effect.scoped(
    Effect.gen(function* () {
      const { url } = yield* stack
      const browser = yield* headlessChromium
      const buyer = yield* walletContext(browser)
      const { page, problems } = yield* openPage(buyer.context, `${url}/sign-in`)
      yield* Effect.promise(() => page.getByRole('button', { name: 'Connect wallet' }).click())
      yield* Effect.promise(() => page.getByRole('button', { name: 'Sign in', exact: true }).click())
      const short = `${buyer.wallet.address.slice(0, 6)}…${buyer.wallet.address.slice(-4)}`
      yield* Effect.promise(() => page.getByText(`Wallet ${short}`).waitFor({ timeout: 15000 }))
      expect(new URL(page.url()).pathname).toBe('/')

      yield* Effect.promise(() =>
        page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Post a request' }).click(),
      )
      const title = `A poster for the acceptance run ${generatePrivateKey().slice(2, 10)}`
      yield* Effect.promise(() => page.getByLabel('What do you need?').fill(title))
      yield* Effect.promise(() => page.getByLabel('Details').fill('A2, two colours, by Friday.'))
      yield* Effect.promise(() => page.getByRole('button', { name: 'Post the request' }).click())
      yield* Effect.promise(() => page.waitForURL(/\/jobs\/job_[0-9A-HJKMNP-TV-Z]{26}$/u, { timeout: 15000 }))
      yield* Effect.promise(() => page.getByRole('heading', { level: 1, name: title }).waitFor({ timeout: 15000 }))
      // The buyer's own view: their request, open, and no proposals yet.
      yield* Effect.promise(() => page.getByText('No proposals yet.', { exact: false }).waitFor({ timeout: 15000 }))

      const visitor = yield* walletContext(browser)
      const home = yield* openPage(visitor.context, url)
      yield* reloadUntilShown(home.page, title)
      const link = home.page.getByRole('link', { name: title })
      expect(yield* Effect.promise(() => link.getAttribute('href'))).toBe(new URL(page.url()).pathname)

      // Rendered with its data on the server, the page hydrates from it and reads none of it again.
      const jobPath = new URL(page.url()).pathname
      const homeReads = yield* apiReadsDuring(home.page, url)
      expect(homeReads).toEqual([])
      yield* Effect.promise(() => home.page.getByRole('link', { name: title }).waitFor({ timeout: 1000 }))
      // The buyer's own view of the job, rendered for their session: the request, and no proposals yet.
      const buyerReads = yield* apiReadsDuring(page, `${url}${jobPath}`)
      expect(buyerReads.filter((path) => path.startsWith('/api/jobs/') && !path.endsWith('/rooms'))).toEqual([])
      expect(buyerReads).not.toContain('/api/session')
      yield* Effect.promise(() => page.getByRole('heading', { level: 1, name: title }).waitFor({ timeout: 1000 }))
      yield* Effect.promise(() => page.getByText('No proposals yet.', { exact: false }).waitFor({ timeout: 1000 }))
      expect(problems).toEqual([])
      expect(home.problems).toEqual([])
    }),
  ),
  { timeout: 120000 },
)

test(
  'renders the home page and a job page with a posted request in the HTML, readable without JavaScript',
  Effect.gen(function* () {
    const { url } = yield* stack
    const buyer = yield* signedIn(url)
    const title = `Server rendered ${generatePrivateKey().slice(2, 10)}`
    const expiresAt = Math.floor(DateTime.toEpochMillis(yield* DateTime.now) / 1000) + 7 * day
    const job = yield* createdBy(buyer.post('/api/jobs', { title, description: 'In the HTML.', expiresAt }), JobId)
    const html = (path: string, headers: Record<string, string> = {}) =>
      HttpClient.get(`${url}${path}`, { headers: { accept: 'text/html', ...headers } })
    // The open requests are a D1 projection, which follows the job eventually: read until the page shows it.
    const home = yield* html('/').pipe(
      Effect.flatMap((response) =>
        Effect.map(response.text, (body) => ({ body, cacheControl: response.headers['cache-control'] })),
      ),
      Effect.flatMap((read) => (read.body.includes(title) ? Effect.succeed(read) : Effect.fail(new NotYet()))),
      Effect.retry({ schedule: Schedule.spaced('100 millis'), times: 200 }),
    )
    expect(home.body).toContain(`/jobs/${job}`)
    expect(home.cacheControl).toBe('public, max-age=0, s-maxage=10, must-revalidate')
    const anyone = yield* html(`/jobs/${job}`)
    expect(anyone.status).toBe(200)
    expect(yield* anyone.text).toContain(title)
    // The page differs by language and by session; Foldkit adds what it negotiates on itself.
    expect(anyone.headers.vary).toStartWith('Accept-Language, Cookie')
    const own = yield* html(`/jobs/${job}`, { cookie: buyer.cookie })
    const ownBody = yield* own.text
    expect(ownBody).toContain(title)
    // Their own view, for their session alone: never kept by any cache.
    expect(ownBody).toContain('No proposals yet.')
    expect(own.headers['cache-control']).toBe('private, no-store')
  }).pipe(Effect.provide(FetchHttpClient.layer)),
  { timeout: 60000 },
)
