import { Schema } from 'effect'
import { describe, expect, test } from 'vitest'
import { allow, connect, exchange, mcp, startConnecting, Tokens, tool } from './Connect.ts'
import { freshKey, loopback, nip98, origin, signingClock, withGateway } from './GatewayWorld.ts'

const Decision = Schema.Struct({ redirect: Schema.String })

describe('OAuth for MCP clients', () => {
  test('publishes its metadata as its own issuer', () =>
    withGateway(async (gateway) => {
      const server = await (await gateway.fetch('/.well-known/oauth-authorization-server')).json()
      expect(server).toMatchObject({ issuer: origin, code_challenge_methods_supported: ['S256'] })
      const resource = await (await gateway.fetch('/.well-known/oauth-protected-resource/mcp')).json()
      expect(resource).toMatchObject({ resource: `${origin}/mcp`, authorization_servers: [origin] })
    }))

  test('connects a client to an operator’s granted agent, and the token lets it in', () =>
    withGateway(async (gateway) => {
      const operator = freshKey()
      const agent = await gateway.createAgent(operator)
      await gateway.grant(operator, agent, ['propose'])
      const { tokens } = await connect(gateway, operator, agent)
      expect(await tool(gateway, tokens.access_token, 'whoami')).toMatchObject({ ok: true, value: { agent } })
    }))

  test('shows a consent page with a strict policy, only in the browser that opened the request', () =>
    withGateway(async (gateway) => {
      const { consent, cookie } = await startConnecting(gateway)
      expect(consent).toMatch(/^\/consent\/connect_[0-9A-Z]{26}$/u)
      const page = await gateway.fetch(consent, { headers: { cookie } })
      expect(page.status).toBe(200)
      const policy = page.headers.get('content-security-policy') ?? ''
      expect(policy).toContain("default-src 'none'")
      expect(policy).toContain("frame-ancestors 'none'")
      expect(policy).toMatch(/script-src 'nonce-[0-9a-f]{32}'/u)
      expect(await page.text()).toContain('Test client')
      expect((await gateway.fetch(consent)).status).toBe(400)
    }))

  test('lets only the operator allow, only an agent of theirs, only with an active grant', () =>
    withGateway(async (gateway) => {
      const operator = freshKey()
      const clock = signingClock()
      const agent = await gateway.createAgent(operator)
      const { consent, cookie } = await startConnecting(gateway)
      expect(await allow(gateway, operator, consent, cookie, agent, clock.now())).toMatchObject({
        status: 403,
        body: { error: 'no_active_grant', reason: 'NoGrant' },
      })
      await gateway.grant(operator, agent, ['discuss'])
      expect(await allow(gateway, freshKey(), consent, cookie, agent)).toMatchObject({
        status: 403,
        body: { error: 'not_your_agent' },
      })
      const unsigned = await gateway.fetch(`${consent}/allow`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ agent }),
      })
      expect(unsigned.status).toBe(401)
      // An authorization is spent once used: the same request signed at the same second is the same event.
      expect(await allow(gateway, operator, consent, cookie, agent, clock.now())).toMatchObject({
        status: 401,
        body: { reason: 'replayed' },
      })
      clock.tick()
      expect(await allow(gateway, operator, consent, '', agent, clock.now())).toMatchObject({ status: 410 })
      clock.tick()
      const allowed = await allow(gateway, operator, consent, cookie, agent, clock.now())
      expect(allowed.status).toBe(200)
      const answered = new URL(Schema.decodeUnknownSync(Decision)(allowed.body).redirect)
      expect([answered.origin + answered.pathname, answered.searchParams.get('state')]).toEqual([loopback, 'st'])
      expect(answered.searchParams.get('iss')).toBe(origin)
      clock.tick()
      expect(await allow(gateway, operator, consent, cookie, agent, clock.now())).toMatchObject({ status: 410 })
    }))

  test('refuses a wrong PKCE verifier, and a code used twice revokes its connection', () =>
    withGateway(async (gateway) => {
      const operator = freshKey()
      const agent = await gateway.createAgent(operator)
      await gateway.grant(operator, agent, ['discuss'])
      const { client, code, verifier, tokens } = await connect(gateway, operator, agent)
      const again = {
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: loopback,
        client_id: client,
      }
      expect((await exchange(gateway, again)).status).toBe(400)
      expect((await mcp(gateway, tokens.access_token, 'tools/list')).status).toBe(401)

      const second = await startConnecting(gateway)
      const decided = await allow(gateway, operator, second.consent, second.cookie, agent)
      const secondCode =
        new URL(Schema.decodeUnknownSync(Decision)(decided.body).redirect).searchParams.get('code') ?? ''
      const wrong = { ...again, code: secondCode, client_id: second.client, code_verifier: 'x'.repeat(43) }
      expect(await (await exchange(gateway, wrong)).json()).toMatchObject({ error: 'invalid_grant' })
    }))

  test('rotates refresh tokens, and a reused one ends the connection', () =>
    withGateway(async (gateway) => {
      const operator = freshKey()
      const agent = await gateway.createAgent(operator)
      await gateway.grant(operator, agent, ['discuss'])
      const { client, tokens } = await connect(gateway, operator, agent)
      const refresh = { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client }
      const rotated = Schema.decodeUnknownSync(Tokens)(await (await exchange(gateway, refresh)).json())
      expect(rotated.refresh_token).not.toBe(tokens.refresh_token)
      expect((await mcp(gateway, rotated.access_token, 'tools/list')).status).toBe(200)
      expect((await exchange(gateway, refresh)).status).toBe(400)
      expect((await mcp(gateway, rotated.access_token, 'tools/list')).status).toBe(401)
    }))

  test('revokes an access token on request, and deleting the agent ends its connections', () =>
    withGateway(async (gateway) => {
      const operator = freshKey()
      const agent = await gateway.createAgent(operator)
      await gateway.grant(operator, agent, ['discuss'])
      const first = await connect(gateway, operator, agent)
      const revoked = await gateway.fetch('/oauth/revoke', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: first.tokens.access_token }).toString(),
      })
      expect(revoked.status).toBe(200)
      expect((await mcp(gateway, first.tokens.access_token, 'tools/list')).status).toBe(401)
      const second = await connect(gateway, operator, agent)
      expect((await gateway.asOperator(operator, 'DELETE', `/api/agents/${agent}`)).status).toBe(204)
      expect((await mcp(gateway, second.tokens.access_token, 'tools/list')).status).toBe(401)
    }))

  test('challenges MCP without a token, naming where to get one', () =>
    withGateway(async (gateway) => {
      const bare = await mcp(gateway, undefined, 'tools/list')
      expect(bare.status).toBe(401)
      expect(bare.headers.get('www-authenticate')).toContain(
        `resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
      )
      expect((await mcp(gateway, `sqga_${'0'.repeat(64)}`, 'tools/list')).status).toBe(401)
      expect(nip98(freshKey(), origin, 'GET')).toMatch(/^Nostr /u)
    }))
})
