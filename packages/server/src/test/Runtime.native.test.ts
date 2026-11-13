import { expect } from 'bun:test'
import * as Cloudflare from '@alchemy.run/cloudflare'
import { Person, Status } from '@sidequest/protocol'
import * as Alchemy from 'alchemy'
import * as Test from 'alchemy/Test/Bun'
import { Effect, Schema } from 'effect'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import * as HttpClient from 'effect/http/HttpClient'
import { apiPolicy, documentPolicy } from '../EdgeSecurity.ts'
import { compatibility, edgeWorker, sidequestWorkers } from '../Stack.ts'
import { headlessChromium } from './ChromiumWorld.ts'
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
import { derivesKeyFromPasskey, fallsBackWithoutPrf } from './PasskeyJourneys.ts'
import { talksInARoom } from './RoomJourneys.ts'
import { postJson, signedProfile, until } from './EdgeWorld.ts'

// `test:native` builds the website with this release before the test runs (package.json).
const release = 'acceptance'
const forgedCorrelation = 'forged-by-the-client'
// The stage's default inbox relay: a NIP-17 inbox that hands gift wraps only to their authenticated recipients.
const inboxRelay = await startTestRelay({ wrapsForRecipients: true })
// The stack runs without settlement, so the API never calls Arc. Nothing listens on the discard port, so a call would
// fail, and the test needs no network.
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
          env: {
            API: api,
            SIDEQUEST_DEFAULT_INBOX_RELAYS: inboxRelay.url,
            // Passkeys for the page's own hostname, as the virtual authenticator's relying party.
            SIDEQUEST_PASSKEY_RP_ID: 'localhost',
          },
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
  'accepts a signed profile through the edge, and serves it as what the index knows of the key',
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
  'answers an unknown API path with 404, as it answers what phase 1 served: sign-in, accounts, agents, jobs, inbox',
  Effect.gen(function* () {
    const { url } = yield* stack
    expect((yield* HttpClient.get(`${url}/api/nope`)).status).toBe(404)
    for (const path of ['/api/session', '/api/agents', '/api/jobs', '/api/inbox'])
      expect((yield* HttpClient.get(`${url}${path}`)).status).toBe(404)
    expect((yield* postJson(`${url}/api/session/challenge`, {})).status).toBe(404)
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
  'derives a key from a passkey, unlocks it with the passkey after a reload and finds it with storage wiped',
  Effect.scoped(Effect.flatMap(stack, ({ url }) => derivesKeyFromPasskey(url))).pipe(
    Effect.provide(FetchHttpClient.layer),
  ),
  { timeout: 120000 },
)

test(
  'says plainly when a passkey cannot derive a key (no PRF) and offers the in-browser key instead',
  Effect.scoped(Effect.flatMap(stack, ({ url }) => fallsBackWithoutPrf(url))),
  { timeout: 60000 },
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
