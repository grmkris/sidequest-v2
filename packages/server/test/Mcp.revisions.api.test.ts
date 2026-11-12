import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { Schema } from 'effect'
import { describe, expect, test } from 'vitest'
import { ada, type Api, origin, withApi } from './HttpWorld.ts'
import { grantedAgent, inProcessFetch, rpc } from './McpWorld.ts'

// Every MCP revision the endpoint serves, spoken exactly as each defines it on the wire: 2026-07-28 statelessly, and
// 2025-11-25 and 2025-06-18 through `initialize` without a session, so any Worker isolate answers any request. The tool
// list is the same in each, and the official TypeScript SDK client (`@modelcontextprotocol/client` 2.4.0) connects both
// the 2025 way (its default) and by probing for 2026-07-28 (`auto`).

const legacy = ['2025-11-25', '2025-06-18'] as const
const served = ['2026-07-28', ...legacy]

/** One JSON-RPC message to `/mcp` the way a 2025 client sends it: no request metadata, the version in a header. */
const legacyRpc = async (
  api: Api,
  token: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) => {
  const response = await api.fetch('/mcp', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', ...body }),
  })
  const text = await response.text()
  const message: unknown = text === '' ? null : JSON.parse(text)
  return { status: response.status, headers: response.headers, message }
}

const initialize = (api: Api, token: string, protocolVersion: string) =>
  legacyRpc(api, token, {
    id: 0,
    method: 'initialize',
    params: { protocolVersion, capabilities: {}, clientInfo: { name: 'old-client', version: '1' } },
  })

const Listed = Schema.Struct({ result: Schema.Struct({ tools: Schema.Array(Schema.Unknown) }) })
const snapshot = './__snapshots__/McpTools.snap'
const asSnapshot = (tools: ReadonlyArray<unknown>) => `${JSON.stringify(tools, null, 2)}\n`

describe('the MCP endpoint, in each revision it serves,', () => {
  test('negotiates the version in initialize: the one asked for if served, else the newest older one', () =>
    withApi(async (api) => {
      const { token } = await grantedAgent(await api.signIn(ada), ['discuss'])
      for (const [asked, answered] of [
        ['2025-11-25', '2025-11-25'],
        ['2025-06-18', '2025-06-18'],
        ['2025-03-26', '2025-11-25'],
        ['2024-11-05', '2025-11-25'],
        ['2099-01-01', '2025-11-25'],
      ] as const) {
        const reply = await initialize(api, token, asked)
        expect(reply.status).toBe(200)
        expect(reply.headers.get('mcp-session-id')).toBeNull()
        expect(reply.message).toMatchObject({
          id: 0,
          result: {
            protocolVersion: answered,
            capabilities: { tools: {} },
            serverInfo: { name: 'sidequest' },
          },
        })
        expect(JSON.stringify(reply.message)).toContain('"instructions":"Sidequest is a marketplace')
      }
    }))

  test('lists the same tools in every revision', () =>
    withApi(async (api) => {
      const { token } = await grantedAgent(await api.signIn(ada), ['discuss'])
      const modern = Schema.decodeUnknownSync(Listed)((await rpc(api, token, 'tools/list')).message).result.tools
      await expect(asSnapshot(modern)).toMatchFileSnapshot(snapshot)
      for (const version of legacy) {
        // No session: each request stands alone, with only its version header.
        const reply = await legacyRpc(api, token, { id: 1, method: 'tools/list' }, { 'mcp-protocol-version': version })
        expect(reply.status).toBe(200)
        const listed = Schema.decodeUnknownSync(Listed)(reply.message)
        expect(reply.message).not.toHaveProperty('result.resultType')
        await expect(asSnapshot(listed.result.tools)).toMatchFileSnapshot(snapshot)
      }
    }))

  test('calls a tool in an older revision as the same agent, in that revision’s result shape', () =>
    withApi(async (api) => {
      const operator = await api.signIn(ada)
      const { agent, token } = await grantedAgent(operator, ['discuss'])
      for (const version of legacy) {
        const reply = await legacyRpc(
          api,
          token,
          { id: 'call', method: 'tools/call', params: { name: 'whoami', arguments: {} } },
          { 'mcp-protocol-version': version },
        )
        expect(reply.message).toMatchObject({
          jsonrpc: '2.0',
          id: 'call',
          result: { isError: false, structuredContent: { account: operator.account, agent: { id: agent } } },
        })
        expect(JSON.stringify(reply.message)).not.toMatch(/resultType|io\.modelcontextprotocol/)
        const unknown = await legacyRpc(
          api,
          token,
          { id: 2, method: 'tools/call', params: { name: 'pay', arguments: {} } },
          { 'mcp-protocol-version': version },
        )
        expect(unknown.message).toMatchObject({ id: 2, error: { code: -32602, message: "Tool 'pay' not found" } })
      }
    }))

  test('answers ping and notifications without a session, and refuses methods it does not serve', () =>
    withApi(async (api) => {
      const { token } = await grantedAgent(await api.signIn(ada), ['discuss'])
      const version = { 'mcp-protocol-version': '2025-11-25' }
      expect((await legacyRpc(api, token, { method: 'notifications/initialized' }, version)).status).toBe(202)
      expect((await legacyRpc(api, token, { id: 3, method: 'ping' }, version)).message).toEqual({
        jsonrpc: '2.0',
        id: 3,
        result: {},
      })
      expect((await legacyRpc(api, token, { id: 4, method: 'resources/list' }, version)).message).toMatchObject({
        id: 4,
        error: { code: -32601 },
      })
      const batch = await api.fetch('/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...version },
        body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }]),
      })
      expect(batch.status).toBe(400)
    }))

  test('refuses a revision it does not serve, a request with no version, and a header its metadata contradicts', () =>
    withApi(async (api) => {
      const { token } = await grantedAgent(await api.signIn(ada), ['discuss'])
      const list = { id: 5, method: 'tools/list' }
      expect(await legacyRpc(api, token, list, { 'mcp-protocol-version': '2024-11-05' })).toMatchObject({
        status: 400,
        message: { id: 5, error: { code: -32022, data: { supported: served, requested: '2024-11-05' } } },
      })
      // A 2025 client that sends no version header speaks 2025-03-26, which is not served.
      expect(await legacyRpc(api, token, list)).toMatchObject({
        status: 400,
        message: { error: { code: -32022, data: { requested: '2025-03-26' } } },
      })
      const contradicted = await rpc(api, token, 'tools/list', {}, { 'mcp-protocol-version': '2025-11-25' })
      expect(contradicted).toMatchObject({ status: 400, message: { error: { code: -32020 } } })
    }))

  test('names every served revision in 2026-07-28 discovery', () =>
    withApi(async (api) => {
      const { token } = await grantedAgent(await api.signIn(ada), ['discuss'])
      expect((await rpc(api, token, 'server/discover')).message).toMatchObject({
        result: { supportedVersions: served, capabilities: { tools: {} } },
      })
    }))

  test('serves the official SDK client the 2025 way and, probing, the 2026 way', () =>
    withApi(async (api) => {
      const operator = await api.signIn(ada)
      const { agent, token } = await grantedAgent(operator, ['discuss'])
      for (const mode of ['legacy', 'auto'] as const) {
        const client = new Client({ name: 'sdk-interop', version: '1' }, { versionNegotiation: { mode } })
        const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
          fetch: inProcessFetch(api),
          requestInit: { headers: { authorization: `Bearer ${token}` } },
        })
        await client.connect(transport)
        expect(client.getNegotiatedProtocolVersion()).toBe(mode === 'legacy' ? '2025-11-25' : '2026-07-28')
        const { tools } = await client.listTools()
        expect(tools.map(({ name }) => name)).toContain('whoami')
        const called = await client.callTool({ name: 'whoami', arguments: {} })
        expect(called.structuredContent).toMatchObject({ account: operator.account, agent: { id: agent } })
        await client.close()
      }
    }))
})
