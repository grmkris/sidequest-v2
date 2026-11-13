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
import { connectRelay, keyAuth, type RelayFailure } from '@sidequest/nostr/relay'
import { foundingOf, type RelayPort, RelayPortFailure } from '@sidequest/nostr/rooms'
import { messagingRelaysTemplate, RelayUrl } from '@sidequest/nostr/vocabulary'
import { Person, SignedEvent, textDigest, UsdcOnArcTestnet } from '@sidequest/protocol'
import { compatibility, sidequestWorkers } from '@sidequest/server/Stack'
import * as Alchemy from 'alchemy'
import * as Test from 'alchemy/Test/Bun'
import { Duration, Effect, Option, Redacted, Schema } from 'effect'
import { Base64Url } from 'effect/encoding'
import { McpClient, McpProtocol } from 'effect/ai'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import { anyone, nostrPerson, sign } from '../../packages/server/rehearsal/Nostr.ts'
import { eventually } from '../../packages/server/rehearsal/Surfaces.ts'
import { startTestRelay } from '../../packages/server/test/TestRelay.ts'
import { personRooms } from '../../apps/gateway/test/MemoryRooms.ts'

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

// The members' inbox relay, as NIP-17 inbox relays should be: gift wraps only for their recipients, after NIP-42.
const inboxRelay = await startTestRelay({ wrapsForRecipients: true })

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
    // `local` lets the gateway's room tools reach the test relay on 127.0.0.1; a deployed stage never passes it.
    const gateway = yield* gatewayWorker({
      coreUrl: core.url,
      release,
      secret: gatewaySecret,
      grantCacheSeconds,
      relayPolicy: 'local',
    })
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
harness.afterAll(harness.destroy(Stack).pipe(Effect.ensuring(Effect.promise(() => inboxRelay.close()))), {
  timeout: 60000,
})

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

/** An MCP client at the gateway's `/mcp`, with the access token the operator's consent gave. */
const mcpClient = (gatewayUrl: string, accessToken: string) =>
  McpClient.make({ name: 'gateway-acceptance', version: '1' }).pipe(
    Effect.provideServiceEffect(
      McpClient.Transport,
      McpClient.http({
        url: `${gatewayUrl}/mcp`,
        protocol: McpProtocol.v2026_07_28,
        headers: { authorization: `Bearer ${accessToken}` },
      }),
    ),
  )

test(
  'an operator grants a gateway agent, an MCP client connects over OAuth, the agent proposes; revoked, it is refused',
  Effect.gen(function* () {
    const { url, gatewayUrl } = yield* stack
    const { request, agent, grant, tokens, revoke } = yield* Effect.promise(() => prepare(url, gatewayUrl))
    const client = yield* mcpClient(gatewayUrl, tokens.access_token)
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

// Rooms (ADR-0004): people hold their rooms in this process, as their browser would, over the same relay.

const portFailure = (failure: RelayFailure) => new RelayPortFailure({ relay: failure.relay, reason: failure.reason })
const clientTiming = {
  connectTimeout: Duration.seconds(5),
  replyTimeout: Duration.seconds(10),
  maxFrameLength: 262_144,
}

/** NIP-01 to the test relay, authenticating as `key`. */
const relayPortOf = (key: SecretKey): RelayPort => {
  const over = <A>(
    relay: string,
    use: (connection: Effect.Success<ReturnType<typeof connectRelay>>) => Effect.Effect<A, RelayFailure>,
  ) =>
    Effect.scoped(Effect.flatMap(connectRelay(relay, { ...clientTiming, auth: Option.some(keyAuth(key)) }), use)).pipe(
      Effect.mapError(portFailure),
    )
  return {
    publish: (relay, event) => over(relay, (connection) => connection.publish(event)),
    query: (relay, filter) => over(relay, (connection) => connection.query(filter)),
  }
}

/** The inbox relays the core's index knows for `pubkey`. */
const inboxRelaysAt = (url: string) => (pubkey: string) =>
  Effect.promise(async () => {
    const reply = await fetch(`${url}/api/people/${pubkey}`)
    if (reply.status !== 200) return []
    const person = Schema.decodeUnknownSync(Person)(await reply.json())
    return (person.messagingRelays?.relays ?? []).map((relay) => Schema.decodeSync(RelayUrl)(relay))
  })

/** A person's rooms over the test relay, learning inbox relays from the core's index. */
const roomsOf = (url: string, key: SecretKey) => personRooms(key, relayPortOf(key), inboxRelaysAt(url))

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

/** The person's kind-10050 list naming the test relay, published through the core. */
const inboxListOf = (key: SecretKey) =>
  finalizeEvent(
    messagingRelaysTemplate([Schema.decodeSync(RelayUrl)(inboxRelay.url)], now()),
    key,
    Schema.decodeSync(Entropy)(entropy()),
  )

/** An operator with an agent granted `discuss`, connected over OAuth; a buyer's request; both inbox lists known. */
const prepareRoom = async (url: string, gatewayUrl: string) => {
  const core = anyone(url)
  const operator = nostrPerson('operator')
  const buyer = nostrPerson('buyer')
  const request = await sign.request(buyer, 'A logo, discussed in a room')
  await core.publish(request)
  for (const person of [operator, buyer]) await core.publish(inboxListOf(person.key))
  const created = await authorized(
    operator.key,
    `${gatewayUrl}/api/agents`,
    'POST',
    JSON.stringify({ label: 'Talker' }),
  )
  const { agent } = Schema.decodeUnknownSync(Created)(await json(created))
  const content = {
    agent,
    scopes: ['discuss' as const],
    notBefore: now() - 60,
    expiresAt: now() + 3600,
    label: 'Talker',
  }
  await core.publish(await signedBy(operator.key, agentGrant, content))
  const tokens = await connectOverOAuth(gatewayUrl, operator.key, agent)
  return { operator, buyer, request, agent, tokens }
}

test(
  'an operator adds their gateway agent to a room; it reads and answers, six in a row at most, and pauses',
  Effect.gen(function* () {
    const { url, gatewayUrl } = yield* stack
    const { operator, buyer, request, agent, tokens } = yield* Effect.promise(() => prepareRoom(url, gatewayUrl))
    const client = yield* mcpClient(gatewayUrl, tokens.access_token)
    const tools = yield* client.listTools()
    const call = (name: string, args: object = {}) =>
      Effect.gen(function* () {
        const found = tools.find((each) => each.name === name)
        if (found === undefined) return yield* Effect.die(new Error(`No tool ${name}`))
        const result = yield* client.callTool({ tool: found, arguments: args })
        const error = result.isError ?? false
        return { error, text: JSON.stringify(error ? result.content : result.structuredContent) }
      })

    // The agent names its inbox relay, published through the core like anyone's.
    expect(yield* call('set_inbox_relays', { relays: [inboxRelay.url] })).toMatchObject({ error: false })
    const founding = foundingOf(request.id, buyer.pubkey, operator.pubkey)
    const ofBuyer = yield* Effect.promise(() => roomsOf(url, buyer.key))
    const ofOperator = yield* Effect.promise(() => roomsOf(url, operator.key))
    yield* Effect.promise(() => run(ofBuyer.create(founding)))
    yield* Effect.promise(() => run(ofOperator.create(founding)))
    yield* Effect.promise(() => run(ofOperator.add(founding.room, agent)))

    expect((yield* call('list_rooms', { job: request.id })).text).toContain(founding.room)
    yield* Effect.promise(() => run(ofBuyer.poll))
    yield* Effect.promise(() => run(ofBuyer.send(founding.room, { _tag: 'Text', text: 'When can you start?' })))
    expect((yield* call('read_room_messages')).text).toContain('When can you start?')

    for (const turn of [1, 2, 3, 4, 5, 6]) {
      const answered = yield* call('send_room_message', { room: founding.room, text: `Answer ${turn}` })
      expect(answered).toMatchObject({ error: false })
    }
    const seventh = yield* call('send_room_message', { room: founding.room, text: 'Answer 7' })
    expect(seventh.error).toBe(true)
    expect(seventh.text).toContain('TurnLimit')
    yield* Effect.promise(() => run(ofBuyer.poll))
    const read = yield* Effect.promise(() => run(ofBuyer.transcript(founding.room)))
    expect(read.messages.at(-1)).toMatchObject({ author: agent, viaGateway: true, act: { text: 'Answer 6' } })
    // The two that read authenticated first: the relay serves gift wraps to their recipients alone.
    for (const member of [buyer.pubkey, agent]) expect(inboxRelay.authenticated.has(member)).toBe(true)

    const pause = `${gatewayUrl}/api/agents/${agent}/pause`
    expect((yield* Effect.promise(() => authorized(operator.key, pause, 'POST'))).status).toBe(200)
    const paused = yield* call('read_room_messages')
    expect(paused.error).toBe(true)
    expect(paused.text).toContain('Paused')
    expect((yield* Effect.promise(() => authorized(operator.key, pause, 'DELETE'))).status).toBe(200)
    expect(yield* call('read_room_messages')).toMatchObject({ error: false })
  }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
  { timeout: 180000 },
)
