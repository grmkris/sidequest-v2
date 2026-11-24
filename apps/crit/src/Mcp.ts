/**
 * `/mcp`: crit as an MCP server over Streamable HTTP, behind the publish token. Stateless: every
 * POST is one JSON-RPC message answered as JSON, with no sessions and no stream, which is all these tools need.
 * Written by hand (about 100 lines) to keep the recipe's dependencies to Alchemy, Effect and pele.
 */
import { Effect, Option, Schema } from 'effect'
import { authorized } from './Api.ts'
import type { Env } from './Env.ts'
import { guardHeaders, json, type Refused, type Unavailable } from './Http.ts'
import { tools } from './McpTools.ts'

const versions = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
const fallbackVersion = '2025-06-18'

const Id = Schema.Union([Schema.String, Schema.Number])
const Message = Schema.Struct({
  jsonrpc: Schema.Literal('2.0'),
  id: Schema.optionalKey(Id),
  method: Schema.String,
  params: Schema.optionalKey(Schema.Unknown),
})
const Initialize = Schema.Struct({ protocolVersion: Schema.String })
const Call = Schema.Struct({ name: Schema.String, arguments: Schema.optionalKey(Schema.Unknown) })

const decodeMessage = Schema.decodeUnknownOption(Message)
const decodeInitialize = Schema.decodeUnknownOption(Initialize)
const decodeCall = Schema.decodeUnknownOption(Call)

type Id = typeof Id.Type
const result = (id: Id, value: unknown) => json({ jsonrpc: '2.0', id, result: value })
const failure = (id: Id | null, code: number, message: string, status = 200) =>
  json({ jsonrpc: '2.0', id, error: { code, message } }, status)

const instructions =
  'crit holds pages for people to review. Publish a page (the team opens it signed in), share it by link or make ' +
  'it public only when a person asked and it has no private data, read what ' +
  'people wrote with comments_read and answer with comment_reply. People resolve threads; agents do not. Do not ' +
  'publish status boards: publish findings, and take a page down when its question is settled.'

const initialize = (params: unknown) => {
  const asked = Option.getOrUndefined(decodeInitialize(params))?.protocolVersion ?? ''
  return {
    protocolVersion: versions.includes(asked) ? asked : fallbackVersion,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: 'crit', title: 'crit', version: '1.0.0' },
    instructions,
  }
}

const listed = () => ({
  tools: tools.map(({ name, title, description, inputSchema, annotations }) => ({
    name,
    title,
    description,
    inputSchema,
    annotations: { title, ...annotations },
  })),
})

/** A tool's answer. A refusal is the tool's own result (`isError`), so the model reads why and can correct itself. */
const call = (env: Env, origin: string, params: unknown): Effect.Effect<unknown, Unavailable> => {
  const asked = Option.getOrUndefined(decodeCall(params))
  const tool = tools.find((candidate) => candidate.name === asked?.name)
  if (asked === undefined || tool === undefined) {
    return Effect.succeed({ content: [{ type: 'text', text: 'No such tool.' }], isError: true })
  }
  return tool.run(env, origin, asked.arguments ?? {}).pipe(
    Effect.map((text) => ({ content: [{ type: 'text', text }], isError: false })),
    Effect.catchTag('Refused', (refusal: Refused) =>
      Effect.succeed({
        content: [
          { type: 'text', text: `${refusal.error}${refusal.detail === undefined ? '' : `: ${refusal.detail}`}` },
        ],
        isError: true,
      }),
    ),
  )
}

export const mcp = Effect.fn('crit.mcp')(function* (request: Request, env: Env, url: URL) {
  yield* authorized(request, env)
  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { ...guardHeaders, allow: 'POST' } })
  }
  const body: unknown = yield* Effect.orElseSucceed(
    Effect.tryPromise((): Promise<unknown> => request.json()),
    () => undefined,
  )
  const message = Option.getOrUndefined(decodeMessage(body))
  if (message === undefined) return failure(null, -32_600, 'Invalid request', 400)
  // A notification (no id) is taken and not answered.
  if (message.id === undefined) return new Response(null, { status: 202, headers: guardHeaders })
  if (message.method === 'initialize') return result(message.id, initialize(message.params))
  if (message.method === 'ping') return result(message.id, {})
  if (message.method === 'tools/list') return result(message.id, listed())
  if (message.method === 'tools/call') return result(message.id, yield* call(env, url.origin, message.params))
  return failure(message.id, -32_601, 'Method not found')
})
