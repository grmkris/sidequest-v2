/**
 * The MCP part of the journey (Journey.native.test.ts): an agent with only the publish token and no files publishes a
 * page, opens and closes it, shares it, reads what a guest wrote and answers, all through `/mcp`.
 */
import { expect } from 'bun:test'
import { Schema } from 'effect'
import type { Instance } from '../scripts/client.ts'

const Answer = Schema.Struct({
  jsonrpc: Schema.Literal('2.0'),
  id: Schema.Union([Schema.String, Schema.Number, Schema.Null]),
  result: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.Struct({ code: Schema.Number, message: Schema.String })),
})
const ToolResult = Schema.Struct({
  content: Schema.Array(Schema.Struct({ type: Schema.Literal('text'), text: Schema.String })),
  isError: Schema.Boolean,
})
const Listing = Schema.Struct({
  tools: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      description: Schema.String,
      inputSchema: Schema.Struct({ type: Schema.Literal('object'), additionalProperties: Schema.Literal(false) }),
      annotations: Schema.Struct({ readOnlyHint: Schema.Boolean, destructiveHint: Schema.Boolean }),
    }),
  ),
})
const Initialized = Schema.Struct({
  protocolVersion: Schema.String,
  capabilities: Schema.Struct({ tools: Schema.Unknown }),
  serverInfo: Schema.Struct({ name: Schema.String }),
})

const post = (to: Instance, body: unknown, token = to.token) =>
  fetch(`${to.url}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  })

let nextId = 1
const rpc = async (to: Instance, method: string, params?: unknown) => {
  const response = await post(to, { jsonrpc: '2.0', id: nextId++, method, ...(params === undefined ? {} : { params }) })
  expect(response.status).toBe(200)
  return Schema.decodeUnknownSync(Answer)(await response.json())
}
/** A tool's text, with `!` in front when the tool refused. */
const tool = async (to: Instance, name: string, args: unknown = {}): Promise<string> => {
  const answer = await rpc(to, 'tools/call', { name, arguments: args })
  const result = Schema.decodeUnknownSync(ToolResult)(answer.result)
  return `${result.isError ? '!' : ''}${result.content.map((part) => part.text).join('\n')}`
}

const handshake = async (to: Instance) => {
  expect((await post(to, { jsonrpc: '2.0', id: 1, method: 'ping' }, 'wrong')).status).toBe(401)
  expect((await fetch(`${to.url}/mcp`, { headers: { authorization: `Bearer ${to.token}` } })).status).toBe(405)

  const hello = await rpc(to, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: {} })
  expect(Schema.decodeUnknownSync(Initialized)(hello.result)).toMatchObject({
    protocolVersion: '2025-06-18',
    serverInfo: { name: 'crit' },
  })
  const future = await rpc(to, 'initialize', { protocolVersion: '2099-01-01' })
  expect(Schema.decodeUnknownSync(Initialized)(future.result).protocolVersion).toBe('2025-06-18')
  expect((await post(to, { jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202)
  expect((await rpc(to, 'ping')).result).toEqual({})
  expect((await rpc(to, 'resources/list')).error?.code).toBe(-32_601)
  expect((await post(to, 'not a message')).status).toBe(400)

  const { tools } = Schema.decodeUnknownSync(Listing)((await rpc(to, 'tools/list')).result)
  expect(tools.map((item) => item.name)).toEqual([
    'pages_list',
    'page_publish',
    'page_visibility',
    'page_share',
    'link_revoke',
    'comments_read',
    'comment_reply',
  ])
  expect(tools.filter((item) => item.annotations.readOnlyHint).map((item) => item.name)).toEqual([
    'pages_list',
    'comments_read',
  ])
}

const working = async (to: Instance) => {
  const html = '<!doctype html><title>From an agent</title><main><h1>Found it</h1><p class="lead">The cause.</p></main>'
  expect(
    await tool(to, 'page_publish', { slug: 'finding', html, assets: [{ path: 'data.json', text: '{"n":1}' }] }),
  ).toMatch(/^Published finding, version 1 \(2 files\)/u)
  expect(await tool(to, 'pages_list')).toContain('- finding: "From an agent", version 1, team')
  // Open to anyone on the agent's word, and closed again: the page's own address under /p/ follows.
  const opened = await tool(to, 'page_visibility', { slug: 'finding', visibility: 'public' })
  expect(opened).toContain(`Anyone opens it at ${to.url}/p/finding/.`)
  expect((await fetch(`${to.url}/p/finding/`)).status).toBe(200)
  const again = { slug: 'finding', html, assets: [{ path: 'data.json', text: '{"n":1}' }], public: false }
  expect(await tool(to, 'page_publish', again)).toMatch(/version 2/u)
  expect((await fetch(`${to.url}/p/finding/`)).status).toBe(404)
  expect(await tool(to, 'page_visibility', { slug: 'ghost', visibility: 'public' })).toBe('!page_not_found')
  expect(await tool(to, 'page_publish', { slug: 'api', html })).toMatch(/^!reserved_name/u)
  expect(await tool(to, 'page_publish', { slug: 'finding', html, extra: true })).toBe('!invalid_arguments')
  expect(await tool(to, 'page_publish', { slug: 'leak', html: `<p>ghp_${'a'.repeat(36)}</p>` })).toMatch(
    /^!secrets_found: index\.html: GitHub token/u,
  )
  expect(await tool(to, 'no_such_tool')).toBe('!No such tool.')

  const shared = await tool(to, 'page_share', { slug: 'finding', days: 1 })
  const link = /^(\S+\/s\/[A-Za-z0-9_-]{22}\/finding\/)$/mu.exec(shared)?.[1] ?? ''
  const linkId = /Link id: ([0-9a-f]{16})/u.exec(shared)?.[1] ?? ''
  expect([link, linkId]).not.toContain('')
  const spare = await tool(to, 'page_share', { slug: 'finding' })
  const spareId = /Link id: ([0-9a-f]{16})/u.exec(spare)?.[1] ?? ''
  expect(await tool(to, 'link_revoke', { slug: 'finding', id: spareId })).toBe('finding: 1 links revoked.')
  const page = await fetch(link)
  expect(page.status).toBe(200)
  expect(await page.text()).toContain('<h1>Found it</h1>')
  expect((await fetch(`${link}data.json`)).headers.get('content-type')).toContain('application/json')

  // A guest writes on the page; the agent reads it and answers; nobody but a person resolves.
  expect(await tool(to, 'comments_read', { page: 'finding' })).toBe('No comments.\n')
  const written = await fetch(`${link}_crit/comments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-crit-key': 'k'.repeat(24) },
    body: JSON.stringify({
      page: 'finding',
      anchor: 'top/h1/x',
      anchorText: 'Found it',
      parentId: null,
      body: 'Which commit?',
      name: 'Ana',
    }),
  })
  expect(written.status).toBe(201)
  const threads = await tool(to, 'comments_read', { page: 'finding' })
  expect(threads).toContain('Which commit?')
  const thread = /thread `([0-9a-f-]{36})`/u.exec(threads)?.[1] ?? ''
  expect(await tool(to, 'comment_reply', { thread, body: 'abc1234, on main.', name: 'claude' })).toMatch(
    /^Replied on finding as claude/u,
  )
  expect(await tool(to, 'comments_read', { page: 'finding' })).toContain('abc1234, on main.')
  expect(await tool(to, 'comment_reply', { thread: '0'.repeat(36), body: 'x' })).toBe('!thread_not_found')
  expect(await tool(to, 'comments_read', { status: 'closed' })).toBe('!invalid_arguments')

  expect(await tool(to, 'link_revoke', { slug: 'finding' })).toBe('finding: 1 links revoked.')
  expect((await fetch(link)).status).toBe(404)
}

export const overMcp = async (to: Instance) => {
  await handshake(to)
  await working(to)
}
