import {
  type AccountId,
  AgentId,
  type GrantScope,
  InboxEntry,
  IssuedAgentToken,
  SessionView,
  SignInChallenge,
  type TypedData,
} from '@sidequest/protocol'
import { Data, Effect, Predicate, Schedule, Schema } from 'effect'
import { McpClient, McpProtocol } from 'effect/ai'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import { type Hex, isAddress } from 'viem'
import { type PrivateKeyAccount, privateKeyToAccount } from 'viem/accounts'

// The public surfaces only: a person is a wallet that signs in with SIWE and then uses the HTTP API as the website
// does (JSON, the site's Origin, the session cookie); an agent is an MCP client holding the token its person issued.
// Nothing here reaches the model, the database or a Durable Object directly.

/** What the API answered. */
export interface Reply {
  readonly status: number
  readonly body: unknown
}

/** A signed-in person: their wallet, their account and their requests. */
export interface Person {
  readonly name: string
  readonly wallet: PrivateKeyAccount
  readonly account: AccountId
  readonly get: (path: string) => Promise<Reply>
  readonly post: (path: string, body?: unknown) => Promise<Reply>
  readonly put: (path: string, body: unknown) => Promise<Reply>
}

/** A refused request, with what the API said. */
export class Refused extends Data.TaggedError('Refused')<{ readonly message: string }> {}

/** An MCP call that failed below the tool: in the transport, the HTTP exchange or the protocol. */
export class McpFailed extends Data.TaggedError('McpFailed')<{ readonly message: string }> {}

/**
 * What an MCP client failure carries, down to the wire: each error's name and message, an HTTP status and a code where
 * one has them, then its cause. "MCP HTTP request failed" alone hides whether the server answered at all.
 */
const detailOf = (failure: unknown, depth = 0): string => {
  if (!Predicate.isObject(failure) || depth > 8) return String(failure)
  const name = Predicate.hasProperty(failure, 'name') ? String(failure.name) : 'Error'
  const message = Predicate.hasProperty(failure, 'message') ? String(failure.message) : ''
  const status = Predicate.hasProperty(failure, 'status') ? ` (HTTP ${String(failure.status)})` : ''
  const code =
    Predicate.hasProperty(failure, 'code') && (Predicate.isString(failure.code) || Predicate.isNumber(failure.code))
      ? ` [${failure.code}]`
      : ''
  const cause = Predicate.hasProperty(failure, 'cause') ? failure.cause : undefined
  return `${name}: ${message}${status}${code}${cause === undefined ? '' : ` <- ${detailOf(cause, depth + 1)}`}`
}

const send = async (url: string, method: string, path: string, cookie: string, body?: unknown): Promise<Reply> => {
  const headers: Record<string, string> = { origin: url, cookie }
  const response = await fetch(
    `${url}${path}`,
    body === undefined
      ? { method, headers }
      : { method, headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) },
  )
  const text = await response.text()
  return { status: response.status, body: text === '' ? null : JSON.parse(text) }
}

/** The body of a successful reply, as `schema` reads it; otherwise the reply, refused. */
export const bodyOf = <A>(schema: Schema.Decoder<A>, reply: Reply, what: string): A => {
  if (reply.status < 200 || reply.status > 299)
    throw new Refused({ message: `${what}: ${reply.status} ${JSON.stringify(reply.body)}` })
  return Schema.decodeUnknownSync(schema)(reply.body)
}

/** Sign `key`'s wallet in through the edge: a challenge, its SIWE message signed, the session cookie kept. */
export const signIn = async (url: string, name: string, key: Hex): Promise<Person> => {
  const wallet = privateKeyToAccount(key)
  const challenge = await send(url, 'POST', '/api/session/challenge', '', { address: wallet.address })
  const { message } = bodyOf(SignInChallenge, challenge, `${name}'s sign-in challenge`)
  const verified = await fetch(`${url}/api/session/verify`, {
    method: 'POST',
    headers: { origin: url, 'content-type': 'application/json' },
    body: JSON.stringify({ message, signature: await wallet.signMessage({ message }) }),
  })
  const cookie = (verified.headers.get('set-cookie') ?? '').split('; ')[0] ?? ''
  const { account } = bodyOf(SessionView, { status: verified.status, body: await verified.json() }, `${name}'s sign-in`)
  return {
    name,
    wallet,
    account,
    get: (path) => send(url, 'GET', path, cookie),
    post: (path, body) => send(url, 'POST', path, cookie, body),
    put: (path, body) => send(url, 'PUT', path, cookie, body),
  }
}

/** Sign typed data as the protocol carries it, every integer a decimal string, with `wallet`. */
export const signTyped = (wallet: PrivateKeyAccount, typed: TypedData) => {
  const fields = [...(typed.types[typed.primaryType] ?? [])]
  const message = Object.fromEntries(
    fields.map(({ name, type }) => {
      const value = typed.message[name] ?? ''
      return [name, type.startsWith('uint') ? BigInt(value) : value]
    }),
  )
  const { verifyingContract } = typed.domain
  if (!isAddress(verifyingContract)) throw new Error('The typed data names no contract')
  return wallet.signTypedData({
    domain: { ...typed.domain, verifyingContract },
    types: { [typed.primaryType]: fields },
    primaryType: typed.primaryType,
    message,
  })
}

/** The person's inbox, every page. */
export const inboxOf = async (person: Person) => {
  const Page = Schema.Struct({ items: Schema.Array(InboxEntry), next: Schema.String, more: Schema.Boolean })
  const items: Array<InboxEntry> = []
  for (let cursor: string | undefined, more = true; more;) {
    const page = bodyOf(Page, await person.get(`/api/inbox${cursor === undefined ? '' : `?cursor=${cursor}`}`), 'inbox')
    items.push(...page.items)
    cursor = page.next
    more = page.more
  }
  return items
}

/** An agent: the MCP tools it may call, as the agent whose token it holds. */
export interface Agent {
  readonly id: AgentId
  readonly call: (tool: string, args: Record<string, unknown>) => Promise<unknown>
}

/** Register an agent as `operator`, grant it `scopes` for a day and issue it a token: the person's part, over HTTP. */
export const registerAgent = async (url: string, operator: Person, name: string, scopes: ReadonlyArray<GrantScope>) => {
  const id = bodyOf(Schema.Struct({ id: AgentId }), await operator.post('/api/agents', { name }), 'agent').id
  const expiresAt = Math.floor(Date.now() / 1000) + 86_400
  const granted = await operator.put(`/api/agents/${id}/grant`, { scopes, expiresAt })
  if (granted.status !== 204) throw new Refused({ message: `grant: ${granted.status} ${JSON.stringify(granted.body)}` })
  const { token } = bodyOf(IssuedAgentToken, await operator.post(`/api/agents/${id}/tokens`, {}), 'token')
  return agentAt(url, id, token)
}

/** One tool call through Effect's MCP client, connected for it as the agent holding `token`. */
/**
 * Effect's MCP client, connected as the agent holding `token`, and the tool `name` it lists. Connecting and listing
 * change nothing, so a transport failure there is retried.
 */
const connect = (url: string, token: string, name: string) =>
  Effect.gen(function* () {
    const authorization = `Bearer ${token}`
    const transport = McpClient.http({
      url: `${url}/mcp`,
      protocol: McpProtocol.v2026_07_28,
      headers: { authorization },
    })
    const client = yield* Effect.provideServiceEffect(
      McpClient.make({ name: 'gate-rehearsal', version: '1' }),
      McpClient.Transport,
      transport,
    )
    const tool = (yield* client.listTools()).find((listed) => listed.name === name)
    if (tool === undefined) return yield* Effect.die(new Error(`The MCP server offers no ${name}`))
    return { client, tool }
  }).pipe(Effect.retry({ times: 2, schedule: Schedule.spaced('200 millis') }))

/**
 * One tool call. A read-only tool (its `readOnlyHint`) is retried after a transport failure, which once in a while
 * meets a connection the local runtime closed; a command is not, since it may have arrived.
 */
const callTool = (url: string, token: string, name: string, args: Record<string, unknown>) =>
  Effect.gen(function* () {
    const { client, tool } = yield* connect(url, token, name)
    const call = client.callTool({ tool, arguments: args })
    const reading = tool.annotations?.readOnlyHint === true
    const result = yield* reading
      ? call.pipe(Effect.retry({ times: 2, schedule: Schedule.spaced('200 millis') }))
      : call
    if (result.isError === true)
      return yield* Effect.die(new Refused({ message: `${name}: ${JSON.stringify(result.content)}` }))
    return result.structuredContent
  }).pipe(
    Effect.mapError((failure) => new McpFailed({ message: `${name}: ${detailOf(failure)}` })),
    Effect.scoped,
    Effect.provide(FetchHttpClient.layer),
  )

const agentAt = (url: string, id: AgentId, token: string): Agent => ({
  id,
  call: (tool, args) => Effect.runPromise(callTool(url, token, tool, args)),
})

/**
 * Ask until `done` holds, every `everyMillis` (100 ms) for at most `seconds`: views, projections and the chain follow
 * eventually. What asks a public RPC asks at a block's pace, not this one: the RPC's rate limit is shared with the stack.
 */
export const eventually = async <A>(
  read: () => Promise<A>,
  done: (value: A) => boolean,
  seconds = 60,
  everyMillis = 100,
) => {
  const until = Date.now() + seconds * 1000
  for (;;) {
    const value = await read()
    if (done(value)) return value
    if (Date.now() > until) throw new Error(`Still not there after ${seconds} s: ${JSON.stringify(value, bigints)}`)
    await new Promise((resolve) => setTimeout(resolve, everyMillis))
  }
}

const bigints = (_key: string, value: unknown) => (typeof value === 'bigint' ? String(value) : value)
