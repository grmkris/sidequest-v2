import { AgentToken, IssuedAgentToken, Page } from '@sidequest/protocol'
import { describe, expect, test } from 'vitest'
import { ada, ben, bodyOf, eventually, inSeconds, origin, type Reply, withApi } from './HttpWorld.ts'
import { callTool, grantedAgent, rpc } from './McpWorld.ts'

// An agent's access to MCP: its operator issues it a token over HTTP (shown once, stored hashed, bound to the agent),
// lists and revokes it; every MCP request admits only a live token whose agent is not revoked and whose grant has not
// ended, read on that request. Refusals are RFC 6750 bearer challenges.

const tokensOf = (reply: Reply) => bodyOf(Page(AgentToken), reply)
const challengeOf = (reply: { readonly headers: Headers }) => reply.headers.get('www-authenticate')
/** The challenge every 401 from `/mcp` starts with: the realm, and where a client learns to get a token (RFC 9728). */
const realm = `Bearer realm="sidequest", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`
const invalid = (description: string) => `${realm}, error="invalid_token", error_description="${description}"`

describe('agent tokens', () => {
  test('are issued once to the operator, listed without the secret, and revoked for good', () =>
    withApi(async (api) => {
      const operator = await api.signIn(ada)
      const { agent, token } = await grantedAgent(operator, ['discuss'])
      expect(token).toMatch(/^sqa_[0-9a-f]{64}$/)
      const issued = await operator.post(`/api/agents/${agent}/tokens`, { lifetimeSeconds: 3600 })
      const second = bodyOf(IssuedAgentToken, issued)
      expect(second.expiresAt - second.issuedAt).toBe(3600)
      const response = await api.fetch(`/api/agents/${agent}/tokens`, {
        method: 'POST',
        headers: { origin: 'https://sidequest.test', cookie: operator.cookie, 'content-type': 'application/json' },
        body: '{}',
      })
      expect(response.headers.get('cache-control')).toBe('no-store')
      const listed = tokensOf(await operator.get(`/api/agents/${agent}/tokens`))
      expect(listed.items).toHaveLength(3)
      expect(JSON.stringify(listed)).not.toContain('sqa_')
      expect(listed.items.find(({ id }) => id === second.id)).toEqual({
        id: second.id,
        agent,
        issuedAt: second.issuedAt,
        expiresAt: second.expiresAt,
        revokedAt: null,
      })
      expect((await callTool(api, second.token, 'whoami')).isError).toBe(false)
      expect((await operator.post(`/api/agents/${agent}/tokens/${second.id}/revoke`)).status).toBe(204)
      expect((await operator.post(`/api/agents/${agent}/tokens/${second.id}/revoke`)).status).toBe(204)
      const revoked = tokensOf(await operator.get(`/api/agents/${agent}/tokens`)).items.find(
        ({ id }) => id === second.id,
      )
      expect(revoked?.revokedAt).toBeTypeOf('number')
      const refused = await rpc(api, second.token, 'tools/list')
      expect(refused.status).toBe(401)
      expect(challengeOf(refused)).toBe(invalid('The access token is unknown, expired or revoked.'))
      // The agent's other token still works: revoking one token is not revoking the agent.
      expect((await callTool(api, token, 'whoami')).isError).toBe(false)
    }))

  test('are refused to anyone but the operator, for a revoked agent, with a lifetime out of bounds, or unknown', () =>
    withApi(async (api) => {
      const operator = await api.signIn(ada)
      const stranger = await api.signIn(ben)
      const { agent } = await grantedAgent(operator, ['discuss'])
      const notOperator = { status: 403, body: { reason: 'NotPermitted', evidence: { required: 'operator' } } }
      expect(await stranger.post(`/api/agents/${agent}/tokens`, {})).toMatchObject(notOperator)
      expect(await stranger.get(`/api/agents/${agent}/tokens`)).toMatchObject(notOperator)
      expect(await operator.post('/api/agents/agent_01JCXZ4Q6N8M2V7T3R5W9Y0B1Z/tokens', {})).toMatchObject({
        status: 404,
        body: { reason: 'NotRegistered' },
      })
      for (const lifetimeSeconds of [60, 91 * 86_400, 1.5])
        expect((await operator.post(`/api/agents/${agent}/tokens`, { lifetimeSeconds })).status).toBe(400)
      expect(await operator.post(`/api/agents/${agent}/tokens/token_01JCXZ4Q6N8M2V7T3R5W9Y0B1Z/revoke`)).toMatchObject({
        status: 404,
        body: { reason: 'UnknownToken' },
      })
      const [first] = tokensOf(await operator.get(`/api/agents/${agent}/tokens`)).items
      expect((await stranger.post(`/api/agents/${agent}/tokens/${first?.id ?? ''}/revoke`)).status).toBe(403)
      await operator.post(`/api/agents/${agent}/revoke`)
      expect(await operator.post(`/api/agents/${agent}/tokens`, {})).toMatchObject({
        status: 403,
        body: { reason: 'AgentRevoked', evidence: { agent } },
      })
      expect((await api.anonymous.post(`/api/agents/${agent}/tokens`, {})).status).toBe(401)
    }))
})

describe('the MCP endpoint', () => {
  test('challenges a request with no bearer token, and never takes the session cookie for one', () =>
    withApi(async (api) => {
      const person = await api.signIn(ada)
      const bare = await rpc(api, undefined, 'tools/list')
      expect(bare.status).toBe(401)
      expect(challengeOf(bare)).toBe(realm)
      const withCookie = await rpc(api, undefined, 'tools/list', {}, { cookie: person.cookie })
      expect(withCookie.status).toBe(401)
      const basic = await rpc(api, undefined, 'tools/list', {}, { authorization: 'Basic YWRhOnNlY3JldA==' })
      expect(basic.status).toBe(401)
      const forged = await rpc(api, `sqa_${'0'.repeat(64)}`, 'tools/list')
      expect(forged.status).toBe(401)
      expect(challengeOf(forged)).toBe(invalid('The access token is unknown, expired or revoked.'))
      expect(await rpc(api, 'not-a-token', 'tools/list')).toMatchObject({
        status: 401,
        message: { error: 'invalid_token' },
      })
    }))

  test(
    'refuses a token once its agent is revoked or its grant has ended, read on each request',
    () =>
      withApi(async (api) => {
        const operator = await api.signIn(ada)
        const revoked = await grantedAgent(operator, ['discuss'])
        expect((await callTool(api, revoked.token, 'whoami')).isError).toBe(false)
        await operator.post(`/api/agents/${revoked.agent}/revoke`)
        expect(challengeOf(await rpc(api, revoked.token, 'tools/list'))).toBe(
          invalid('The agent was revoked by its operator.'),
        )
        const ending = await grantedAgent(operator, ['discuss'], inSeconds(2))
        expect((await callTool(api, ending.token, 'whoami')).isError).toBe(false)
        // The grant ends within two seconds; poll for up to five.
        const ended = await eventually(
          async () => {
            await new Promise((resolve) => setTimeout(resolve, 30))
            const reply = await rpc(api, ending.token, 'tools/list')
            return { status: reply.status, body: challengeOf(reply) }
          },
          ({ status }) => status === 401,
        )
        expect(ended).toEqual({ status: 401, body: invalid("The agent's grant has expired.") })
        // A new grant lets the same token in again: the token names the agent, the grant is read now.
        await operator.put(`/api/agents/${ending.agent}/grant`, { scopes: ['discuss'], expiresAt: inSeconds(3600) })
        expect((await rpc(api, ending.token, 'tools/list')).status).toBe(200)
      }),
    15_000,
  )

  test('refuses a body larger than it reads, a browser page’s request, and a request without the MCP headers', () =>
    withApi(async (api) => {
      const { token } = await grantedAgent(await api.signIn(ada), ['discuss'])
      const huge = await api.fetch('/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': '2000000' },
        body: 'x'.repeat(2_000_000),
      })
      expect(huge.status).toBe(413)
      expect((await rpc(api, token, 'tools/list', {}, { origin: 'https://evil.example' })).status).toBe(403)
      // Without the MCP headers, a request names no revision the endpoint serves (`Mcp.revisions.api.test.ts`).
      const bare = await api.fetch('/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      })
      expect(bare.status).toBe(400)
    }))
})
