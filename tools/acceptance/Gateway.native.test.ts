import { expect } from 'bun:test'
import * as Cloudflare from '@alchemy.run/cloudflare'
import { gatewayWorker } from '@sidequest/gateway/Stack'
import { JobView } from '@sidequest/fold'
import {
  Entropy,
  finalizeEvent,
  httpAuthHeader,
  httpAuthTemplate,
  type NostrEvent,
  PublicKey,
  type SecretKey,
} from '@sidequest/nostr'
import {
  agentGrant,
  buildSidequestEvent,
  envelopeTag,
  grantRevocation,
  type KindSpec,
} from '@sidequest/nostr/vocabulary'
import { SignedEvent, textDigest, UsdcOnArcTestnet } from '@sidequest/protocol'
import { compatibility, sidequestWorkers } from '@sidequest/server/Stack'
import * as Alchemy from 'alchemy'
import * as Test from 'alchemy/Test/Bun'
import { Effect, Redacted, Schema } from 'effect'
import { Base64Url } from 'effect/encoding'
import { McpClient, McpProtocol } from 'effect/ai'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import { anyone, nostrPerson, sign } from '../../packages/server/rehearsal/Nostr.ts'
import { eventually } from '../../packages/server/rehearsal/Surfaces.ts'

// The core and the agent gateway deployed together in workerd, each its own Worker and D1, the gateway configured with
// the core's URL alone. An operator (a Nostr key the test holds, as their browser's signer would) makes an agent at the
// gateway and grants it through the core; an MCP client connects to the gateway over OAuth with the operator's
// consent; the agent lists open requests and proposes on a request another key posted; the core's index shows the
// proposal signed by the agent's key with the grant tag; the operator revokes, and the next tool call is refused.

const release = 'gateway-acceptance'
// The core reaches Arc only to check a contract wallet's link; nothing listens on the discard port.
const unreachableRpc = 'http://127.0.0.1:9'
// One second, so the revocation shows within the test; a stage keeps the 30-second default.
const grantCacheSeconds = 1
const gatewaySecret = Redacted.make(
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, '0')).join(''),
)

const Stack = Alchemy.Stack(
  'SidequestGatewayAcceptance',
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const core = yield* sidequestWorkers(
      release,
      () =>
        Cloudflare.Worker('GatewayAcceptanceWebsite', {
          script: 'export default { fetch: () => new Response("no website here", { status: 404 }) }',
          compatibility,
        }),
      unreachableRpc,
    )
    const gateway = yield* gatewayWorker({ coreUrl: core.url, release, secret: gatewaySecret, grantCacheSeconds })
    return { url: core.url, gatewayUrl: gateway.gatewayUrl }
  }),
)

// Its own stage, beside the core's native suite: the two deploy and destroy their stacks independently.
const harness = Test.make({
  stage: 'local-native-gateway',
  dev: true,
  sidecar: { omitEnv: ['CLOUDFLARE_'] },
  state: Alchemy.localState(),
  providers: Cloudflare.providers(),
})
const { test } = harness

/** Both Workers answer: the core's status through its edge, and the gateway's own. */
const ready = ({ url, gatewayUrl }: { readonly url: string; readonly gatewayUrl: string }) =>
  Effect.all([Test.getWhenReady(`${url}/api/status`), Test.getWhenReady(`${gatewayUrl}/status`)], { discard: true })

const stack = harness.beforeAll(harness.deploy(Stack).pipe(Effect.tap(ready), Effect.provide(FetchHttpClient.layer)), {
  timeout: 180000,
})
harness.afterAll(harness.destroy(Stack), { timeout: 60000 })

const now = () => Math.floor(Date.now() / 1000)
const entropy = () => crypto.getRandomValues(new Uint8Array(32))

/** A Sidequest event `key` signs, as the operator's own signer would. */
const signedBy = async <C>(key: SecretKey, spec: KindSpec<C>, content: C): Promise<NostrEvent> => {
  const template = await Effect.runPromise(buildSidequestEvent(spec, content, { createdAt: now() }))
  return finalizeEvent(template, key, Schema.decodeSync(Entropy)(entropy()))
}

/** A request to the gateway carrying `key`'s NIP-98 authorization of exactly it. */
const authorized = async (
  key: SecretKey,
  url: string,
  method: string,
  body?: string,
  headers: Record<string, string> = {},
) => {
  const payload = body === undefined ? {} : { payloadSha256: await Effect.runPromise(textDigest(body)) }
  const template = httpAuthTemplate({ url, method, ...payload }, now())
  const authorization = httpAuthHeader(finalizeEvent(template, key, Schema.decodeSync(Entropy)(entropy())))
  return fetch(url, {
    method,
    headers: { ...headers, authorization, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body }),
  })
}

const json = async (response: Response): Promise<unknown> => response.json()
const Created = Schema.Struct({ agent: PublicKey })
const Registered = Schema.Struct({ client_id: Schema.String })
const Decision = Schema.Struct({ redirect: Schema.String })
const Tokens = Schema.Struct({ access_token: Schema.String, refresh_token: Schema.String })

/** The operator connects an MCP client to `agent` over OAuth: registration, authorization, consent, the token. */
const connectOverOAuth = async (gatewayUrl: string, operator: SecretKey, agent: string) => {
  const redirect = 'http://127.0.0.1:9/callback'
  const registered = await fetch(`${gatewayUrl}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Acceptance', redirect_uris: [redirect] }),
  })
  const { client_id: client } = Schema.decodeUnknownSync(Registered)(await json(registered))
  const verifier = Base64Url.encode(entropy())
  const challenge = Base64Url.encode(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
  )
  const query = new URLSearchParams({ response_type: 'code', client_id: client, redirect_uri: redirect, state: 's' })
  query.set('code_challenge', challenge)
  query.set('code_challenge_method', 'S256')
  const opened = await fetch(`${gatewayUrl}/oauth/authorize?${query.toString()}`, { redirect: 'manual' })
  const consent = opened.headers.get('location') ?? ''
  const cookie = (opened.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
  expect(consent).toMatch(/^\/consent\/connect_/u)
  const page = await fetch(`${gatewayUrl}${consent}`, { headers: { cookie } })
  expect(page.headers.get('content-security-policy')).toContain("default-src 'none'")
  const allowed = await authorized(operator, `${gatewayUrl}${consent}/allow`, 'POST', JSON.stringify({ agent }), {
    cookie,
  })
  expect(allowed.status).toBe(200)
  const code = new URL(Schema.decodeUnknownSync(Decision)(await json(allowed)).redirect).searchParams.get('code') ?? ''
  const exchanged = await fetch(`${gatewayUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: redirect,
      client_id: client,
    }).toString(),
  })
  return Schema.decodeUnknownSync(Tokens)(await json(exchanged))
}

const terms = {
  title: 'A logo',
  deliverables: ['SVG logo'],
  amount: '250000000',
  asset: UsdcOnArcTestnet.id,
  network: UsdcOnArcTestnet.network,
  deliveryDeadline: now() + 30 * 86_400,
  reviewWindowSeconds: 3 * 86_400,
  disputeWindowSeconds: 2 * 86_400,
  arbitrationWindowSeconds: 7 * 86_400,
  rail: 'escrow',
}

/**
 * The world before the agent acts: the operator links a wallet (where their agent's proposals ask to be paid), a
 * buyer posts a request, the operator makes an agent at the gateway, signs its grant and publishes it through the core,
 * and connects an MCP client to it over OAuth.
 */
const prepare = async (url: string, gatewayUrl: string) => {
  const core = anyone(url)
  const operator = nostrPerson('operator')
  const buyer = nostrPerson('buyer')
  await core.publish(await sign.link(operator))
  const request = await sign.request(buyer, 'A logo for a café')
  await core.publish(request)
  const created = await authorized(operator.key, `${gatewayUrl}/api/agents`, 'POST', JSON.stringify({ label: 'Scout' }))
  expect(created.status).toBe(201)
  const { agent } = Schema.decodeUnknownSync(Created)(await json(created))
  const content = {
    agent,
    scopes: ['propose' as const],
    notBefore: now() - 60,
    expiresAt: now() + 3600,
    label: 'Scout',
  }
  const grant = await signedBy(operator.key, agentGrant, content)
  await core.publish(grant)
  const tokens = await connectOverOAuth(gatewayUrl, operator.key, agent)
  const revoke = async () => core.publish(await signedBy(operator.key, grantRevocation, { grant: grant.id }))
  return { request, agent, grant, tokens, revoke }
}

/** The core's index shows the proposal, signed by the agent's key and naming the grant. */
const expectIndexed = async (url: string, job: string, proposal: string, agent: PublicKey, grant: string) => {
  const view = await eventually(
    async () => {
      const reply = await fetch(`${url}/api/index/jobs/${job}`)
      return reply.status === 200 ? Schema.decodeUnknownSync(JobView)(await reply.json()) : undefined
    },
    (folded) => folded?.proposals.some(({ id }) => id === proposal) === true,
  )
  expect(view?.stage).toBe('proposed')
  expect(view?.proposals.find(({ id }) => id === proposal)?.author).toBe(agent)
  const stored = Schema.decodeUnknownSync(SignedEvent)(await json(await fetch(`${url}/api/events/${proposal}`)))
  expect(stored.pubkey).toBe(agent)
  expect(stored.tags).toContainEqual([envelopeTag.grant, grant])
}

test(
  'an operator grants a gateway agent, an MCP client connects over OAuth, the agent proposes; revoked, it is refused',
  Effect.gen(function* () {
    const { url, gatewayUrl } = yield* stack
    const { request, agent, grant, tokens, revoke } = yield* Effect.promise(() => prepare(url, gatewayUrl))
    const client = yield* McpClient.make({ name: 'gateway-acceptance', version: '1' }).pipe(
      Effect.provideServiceEffect(
        McpClient.Transport,
        McpClient.http({
          url: `${gatewayUrl}/mcp`,
          protocol: McpProtocol.v2026_07_28,
          headers: { authorization: `Bearer ${tokens.access_token}` },
        }),
      ),
    )
    const tools = yield* client.listTools()
    const listTool = tools.find((each) => each.name === 'list_open_requests')
    const proposeTool = tools.find((each) => each.name === 'propose')
    if (listTool === undefined || proposeTool === undefined)
      return yield* Effect.die(new Error('The tools are missing'))
    const open = yield* client.callTool({ tool: listTool, arguments: {} })
    expect(JSON.stringify(open.structuredContent)).toContain(request.id)
    const proposed = yield* client.callTool({
      tool: proposeTool,
      arguments: { job: request.id, terms, validUntil: now() + 86_400 },
    })
    expect(proposed.isError ?? false).toBe(false)
    const { proposal } = yield* Schema.decodeUnknownEffect(Schema.Struct({ proposal: Schema.String }))(
      proposed.structuredContent,
    )
    yield* Effect.promise(() => expectIndexed(url, request.id, proposal, agent, grant.id))

    // The operator revokes the grant; past the gateway's window, the agent's next call is refused.
    yield* Effect.promise(revoke)
    yield* Effect.sleep(`${grantCacheSeconds + 1} seconds`)
    const refused = yield* client.callTool({ tool: listTool, arguments: {} })
    expect(refused.isError).toBe(true)
    expect(JSON.stringify(refused.content)).toContain('GrantRevoked')
  }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
  { timeout: 120000 },
)
