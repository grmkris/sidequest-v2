import { AgentId, type GrantScope, IssuedAgentToken } from '@sidequest/protocol'
import { Effect, Layer, Schema, type Scope } from 'effect'
import { McpClient, McpProtocol } from 'effect/ai'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import { type Api, bodyOf, createdId, inSeconds, origin, type Person } from './HttpWorld.ts'

// MCP over HTTP, as an agent uses it: a person registers an agent, grants it scopes and issues it a token over the
// HTTP API; the agent then speaks MCP 2026-07-28 at `/mcp` with that token, through Effect's own MCP client or, where a
// test needs the exact wire, with hand-written JSON-RPC.

export const protocolVersion = '2026-07-28'

/** An agent a person registered and granted `scopes` for an hour, with a token issued for it. */
export interface Granted {
  readonly agent: AgentId
  readonly token: string
}

/** Register an agent as `operator`, grant it `scopes` until `expiresAt`, and issue it a token. */
export const grantedAgent = async (
  operator: Person,
  scopes: ReadonlyArray<GrantScope>,
  expiresAt = inSeconds(3600),
): Promise<Granted> => {
  const agent = createdId(AgentId, await operator.post('/api/agents', { name: 'Scout' }))
  const granted = await operator.put(`/api/agents/${agent}/grant`, { scopes, expiresAt })
  if (granted.status !== 204) throw new Error(`The grant was refused: ${JSON.stringify(granted.body)}`)
  const issued = bodyOf(IssuedAgentToken, await operator.post(`/api/agents/${agent}/tokens`, {}))
  return { agent, token: issued.token }
}

/** What the MCP endpoint answered: the status, the headers and the JSON-RPC message, if it sent one. */
export interface McpReply {
  readonly status: number
  readonly headers: Headers
  readonly message: unknown
}

const metadata = {
  'io.modelcontextprotocol/protocolVersion': protocolVersion,
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'sidequest-test', version: '1' },
}

/** The JSON-RPC message of a response, whether sent as JSON or as one server-sent event. */
const messageOf = (text: string, contentType: string | null): unknown => {
  if (text === '') return null
  if (contentType?.startsWith('text/event-stream') === true) {
    const data = text
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice('data: '.length))
    return JSON.parse(data.at(-1) ?? 'null')
  }
  return JSON.parse(text)
}

/** One JSON-RPC request to `/mcp`, exactly as MCP 2026-07-28 sends it, with `token` as the bearer (if any). */
export const rpc = async (
  api: Api,
  token: string | undefined,
  method: string,
  params: Record<string, unknown> = {},
  extraHeaders: Record<string, string> = {},
): Promise<McpReply> => {
  const name = typeof params['name'] === 'string' ? { 'mcp-name': params['name'] } : {}
  const response = await api.fetch('/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': protocolVersion,
      'mcp-method': method,
      ...name,
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...extraHeaders,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: metadata } }),
  })
  return {
    status: response.status,
    headers: response.headers,
    message: messageOf(await response.text(), response.headers.get('content-type')),
  }
}

/** A tool call's result, from a JSON-RPC response. */
export const ToolResult = Schema.Struct({
  result: Schema.Struct({
    isError: Schema.optional(Schema.Boolean),
    structuredContent: Schema.optional(Schema.Unknown),
    content: Schema.Array(Schema.Struct({ type: Schema.Literal('text'), text: Schema.String })),
  }),
})

/** Call a tool with hand-written JSON-RPC; its result. */
export const callTool = async (api: Api, token: string, name: string, args: Record<string, unknown> = {}) =>
  Schema.decodeUnknownSync(ToolResult)((await rpc(api, token, 'tools/call', { name, arguments: args })).message).result

/**
 * Call until `done` holds, at most a hundred times 20 ms apart: projections and views follow commands eventually.
 * Answers the last result either way, so the test's assertion reports what it saw.
 */
export const untilTool = async (
  call: () => Promise<typeof ToolResult.Type.result>,
  done: (result: typeof ToolResult.Type.result) => boolean,
) => {
  for (let attempt = 1; ; attempt += 1) {
    const result = await call()
    if (done(result) || attempt === 100) return result
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** The refusal a failed tool call carries in its text: the HTTP API's `{ _tag, reason, evidence }`. */
export const refusalOf = (result: typeof ToolResult.Type.result): unknown =>
  result.isError === true ? JSON.parse(result.content[0]?.text ?? 'null') : undefined

/** Effect's MCP client, connected to `/mcp` as the agent holding `token`. */
export const mcpClient = (api: Api, token: string): Effect.Effect<McpClient.McpClient, unknown, Scope.Scope> =>
  Effect.gen(function* () {
    const transport = yield* McpClient.http({
      url: `${origin}/mcp`,
      protocol: McpProtocol.v2026_07_28,
      headers: { authorization: `Bearer ${token}` },
    })
    return yield* McpClient.make({ name: 'sidequest-test', version: '1' }).pipe(
      Effect.provideService(McpClient.Transport, transport),
    )
  }).pipe(
    Effect.provide(
      FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, inProcessFetch(api)))),
    ),
  )

const pathOf = (input: RequestInfo | URL) => {
  const url = new URL(input instanceof Request ? input.url : input)
  return `${url.pathname}${url.search}`
}

/** `fetch` that serves every request from the API's in-process handler, never the network. */
const inProcessFetch = (api: Api): typeof globalThis.fetch =>
  Object.assign((input: RequestInfo | URL, init?: RequestInit) => api.fetch(pathOf(input), init), {
    preconnect: () => undefined,
  })
