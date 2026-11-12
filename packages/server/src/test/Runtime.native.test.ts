import { expect } from 'bun:test'
import * as Cloudflare from '@alchemy.run/cloudflare'
import { Status } from '@sidequest/protocol'
import * as Alchemy from 'alchemy'
import * as Test from 'alchemy/Test/Bun'
import { Effect, Schema } from 'effect'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import * as HttpClient from 'effect/http/HttpClient'
import { chromium } from 'playwright'
import { apiPolicy, documentPolicy } from '../EdgeSecurity.ts'
import { compatibility, edgeWorker, sidequestWorkers } from '../Stack.ts'

// `test:native` builds the website with this release before the test runs (package.json).
const release = 'acceptance'
const forgedCorrelation = 'forged-by-the-client'

// The production Workers around the built website, run in workerd. Website.Foldkit's dev mode runs Vite in Node, which
// cannot prove the deployed Worker, so the website is the SSR artifact itself. A second edge in front of a Worker that
// answers with the headers it received shows what the edge forwards to the API.
const Stack = Alchemy.Stack(
  'SidequestLocalAcceptance',
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const { url } = yield* sidequestWorkers(
      release,
      Cloudflare.Worker('SidequestWebsite', {
        main: 'apps/web/dist/server/fetch.js',
        assets: { directory: 'apps/web/dist/client' },
        compatibility,
      }),
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

test(
  'hydrates the page in headless Chromium without errors and shows the title and release',
  Effect.scoped(
    Effect.gen(function* () {
      const { url } = yield* stack
      const browser = yield* Effect.acquireRelease(
        Effect.promise(() => chromium.launch({ headless: true })),
        (opened) => Effect.promise(() => opened.close()),
      )
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
      expect(text).toContain('Sidequest v2 foundation')
      expect(text).toContain(`Release ${release}`)
      expect(problems).toEqual([])
    }),
  ),
  { timeout: 60000 },
)
