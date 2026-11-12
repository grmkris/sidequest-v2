import { AgentId, AgentToken, Connection, ConnectRequest, Page } from '@sidequest/protocol'
import { Effect, Schema } from 'effect'
import { describe, expect, test } from 'vitest'
import { AgentAccess } from '../src/Agents/AgentAccess.ts'
import { ada, ben, bodyOf, createdId, origin, type Reply, withApi } from './HttpWorld.ts'
import { callTool, grantedAgent, rpc } from './McpWorld.ts'
import {
  asked,
  authorize,
  callbackOf,
  connected,
  consent,
  loopback,
  pkce,
  register,
  registeredClient,
  requestOf,
  resource,
  token,
  Tokens,
} from './OAuthWorld.ts'
import { clientDocuments, fakeArc, signInWorld } from './World.ts'

// OAuth 2.1 for MCP clients, end to end over the API: discovery from the 401, registration, authorization with PKCE,
// the signed-in person's consent, the code for tokens, MCP calls as the chosen agent, refresh with rotation, and
// revocation. Each threat in `OAuthRoutes.ts` has a test here that would fail if its defence were removed.

const invalidGrant = { status: 400, body: { error: 'invalid_grant' } }

const connectionsOf = (reply: Reply) => bodyOf(Schema.Struct({ items: Schema.Array(Connection) }), reply).items

describe('OAuth discovery', () => {
  test('starts from the 401 at /mcp, which names the protected resource metadata, which names this issuer', () =>
    withApi(async (api) => {
      const challenge = (await rpc(api, undefined, 'tools/list')).headers.get('www-authenticate') ?? ''
      const metadataUrl = /resource_metadata="([^"]+)"/u.exec(challenge)?.[1] ?? ''
      expect(metadataUrl).toBe(`${origin}/.well-known/oauth-protected-resource/mcp`)
      for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
        const document = await api.fetch(path)
        expect(document.headers.get('access-control-allow-origin')).toBe('*')
        expect(await document.json()).toEqual({
          resource,
          authorization_servers: [origin],
          bearer_methods_supported: ['header'],
          resource_name: 'Sidequest',
        })
      }
      expect(await (await api.fetch('/.well-known/oauth-authorization-server')).json()).toMatchObject({
        issuer: origin,
        authorization_endpoint: `${origin}/oauth/authorize`,
        token_endpoint: `${origin}/oauth/token`,
        registration_endpoint: `${origin}/oauth/register`,
        revocation_endpoint: `${origin}/oauth/revoke`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        client_id_metadata_document_supported: true,
        authorization_response_iss_parameter_supported: true,
      })
      expect((await api.fetch('/oauth/token', { method: 'OPTIONS' })).status).toBe(204)
    }))
})

describe('dynamic client registration', () => {
  test('registers a public client with the redirects it named, and refuses redirects that are not safe', () =>
    withApi(async (api) => {
      const registered = await register(api, {
        client_name: 'Claude\u0007 Code',
        redirect_uris: [loopback, 'cursor://anysphere.cursor-mcp/oauth/callback', 'https://app.example/cb'],
        token_endpoint_auth_method: 'client_secret_post',
      })
      expect(registered).toMatchObject({
        status: 201,
        body: {
          client_name: 'Claude Code',
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
        },
      })
      expect(JSON.stringify(registered.body)).toMatch(/"client_id":"client_[0-9a-f]{32}"/u)
      expect(registered.headers.get('cache-control')).toBe('no-store')
      for (const redirect of [
        'http://evil.example/cb',
        'javascript:alert(1)',
        'data:text/html,hi',
        'https://app.example/cb#fragment',
        'https://user:pass@app.example/cb',
        'not a uri',
      ])
        expect(await register(api, { redirect_uris: [redirect] })).toMatchObject({
          status: 400,
          body: { error: 'invalid_redirect_uri' },
        })
      expect((await register(api, { redirect_uris: [] })).status).toBe(400)
      expect((await register(api, { redirect_uris: [loopback], grant_types: ['client_credentials'] })).status).toBe(400)
    }))
})

describe('the authorization code flow', () => {
  test('connects a client as the agent the person picks, which then acts as that agent over MCP', () =>
    withApi(async (api) => {
      const person = await api.signIn(ada)
      const { agent } = await grantedAgent(person, ['discuss', 'propose'])
      const client = await registeredClient(api, loopback, 'Test Agent')
      const { verifier, challenge } = pkce()
      const authorized = await authorize(api, asked(client, challenge))
      expect(authorized.status).toBe(302)
      const { id, binding } = requestOf(authorized)
      const browser = consent(api, person, binding)
      const shown = bodyOf(ConnectRequest, await browser.read(id))
      expect(shown).toEqual({
        id,
        client: { id: client, name: 'Test Agent', kind: 'registered', publisher: null },
        redirect: { host: '127.0.0.1:43117', loopback: true },
        resource,
        expiresAt: shown.expiresAt,
      })
      expect(shown.expiresAt - Date.now() / 1000).toBeGreaterThan(9 * 60)
      const callback = callbackOf(await browser.allow(id, agent))
      expect(callback.url.startsWith(`${loopback}?`)).toBe(true)
      expect(callback.query.get('state')).toBe('state-123')
      expect(callback.query.get('iss')).toBe(origin)
      const exchanged = await token(api, {
        grant_type: 'authorization_code',
        code: callback.query.get('code') ?? '',
        code_verifier: verifier,
        redirect_uri: loopback,
        client_id: client,
        resource,
      })
      expect(exchanged.headers.get('cache-control')).toBe('no-store')
      const tokens = bodyOf(Tokens, exchanged)
      expect(tokens.expires_in).toBe(3600)
      const whoami = await callTool(api, tokens.access_token, 'whoami')
      expect(whoami.structuredContent).toMatchObject({
        account: person.account,
        agent: { id: agent, scopes: ['discuss', 'propose'] },
      })
      // The agent's grant is judged on each request: revoking the agent stops its OAuth token too.
      await person.post(`/api/agents/${agent}/revoke`)
      expect((await rpc(api, tokens.access_token, 'tools/list')).status).toBe(401)
    }))

  test('refuses a wrong PKCE verifier, a reused code, a wrong redirect, a wrong resource and another client', () =>
    withApi(async (api) => {
      const person = await api.signIn(ada)
      const { agent } = await grantedAgent(person, ['discuss'])
      const client = await registeredClient(api)
      const attempt = async (change: Record<string, string>) => {
        const { verifier, challenge } = pkce()
        const { id, binding } = requestOf(await authorize(api, asked(client, challenge)))
        const { query } = callbackOf(await consent(api, person, binding).allow(id, agent))
        const form = {
          grant_type: 'authorization_code',
          code: query.get('code') ?? '',
          code_verifier: verifier,
          redirect_uri: loopback,
          client_id: client,
          resource,
        }
        const first = await token(api, { ...form, ...change })
        // Whatever the first attempt, the code is spent: the right parameters no longer redeem it.
        const second = await token(api, form)
        return { first, second }
      }
      for (const change of [
        { code_verifier: pkce().verifier },
        { redirect_uri: 'http://127.0.0.1:43117/other' },
        { resource: 'https://other.example/mcp' },
        { client_id: await registeredClient(api) },
      ]) {
        const { first, second } = await attempt(change)
        expect(first).toMatchObject(invalidGrant)
        expect(second).toMatchObject(invalidGrant)
      }
    }))

  test('revokes everything issued from a code when the code is presented again (replay)', () =>
    withApi(async (api) => {
      const person = await api.signIn(ada)
      const { agent } = await grantedAgent(person, ['discuss'])
      const flow = await connected(api, person, agent)
      expect((await callTool(api, flow.tokens.access_token, 'whoami')).isError).toBe(false)
      const replay = await token(api, {
        grant_type: 'authorization_code',
        code: flow.code,
        code_verifier: flow.verifier,
        redirect_uri: loopback,
        client_id: flow.client,
      })
      expect(replay).toMatchObject(invalidGrant)
      expect((await rpc(api, flow.tokens.access_token, 'tools/list')).status).toBe(401)
      const refresh = { grant_type: 'refresh_token', refresh_token: flow.tokens.refresh_token, client_id: flow.client }
      expect(await token(api, refresh)).toMatchObject(invalidGrant)
    }))

  test('refuses an expired code', () => {
    const world = signInWorld(fakeArc().client)
    return withApi(async (api) => {
      const person = await api.signIn(ada)
      const { agent } = await grantedAgent(person, ['discuss'])
      const client = await registeredClient(api)
      const { verifier, challenge } = pkce()
      const { id, binding } = requestOf(await authorize(api, asked(client, challenge)))
      const { query } = callbackOf(await consent(api, person, binding).allow(id, agent))
      // A minute passes: the code's expiry is moved into the past, as the clock would.
      world.sqlite.exec('UPDATE oauth_connections SET code_expires_at = code_expires_at - 61')
      const exchange = {
        grant_type: 'authorization_code',
        code: query.get('code') ?? '',
        code_verifier: verifier,
        redirect_uri: loopback,
        client_id: client,
      }
      expect(await token(api, exchange)).toMatchObject(invalidGrant)
    }, world.layer)
  })
})

describe('the authorization endpoint', () => {
  test('never redirects to a client or redirect it does not know, and answers every other refusal to the client', () =>
    withApi(async (api) => {
      const client = await registeredClient(api)
      const { challenge } = pkce()
      for (const parameters of [
        asked('client_unknown', challenge),
        asked(client, challenge, { redirect_uri: 'https://evil.example/cb' }),
        asked(client, challenge, { redirect_uri: null }),
      ]) {
        const answered = await authorize(api, parameters)
        expect(answered).toMatchObject({ status: 400, location: null, binding: null })
      }
      for (const [overrides, error] of [
        [{ code_challenge: null }, 'invalid_request'],
        [{ code_challenge_method: 'plain' }, 'invalid_request'],
        [{ code_challenge_method: null }, 'invalid_request'],
        [{ resource: 'https://other.example/mcp' }, 'invalid_target'],
        [{ response_type: 'token' }, 'unsupported_response_type'],
        [{ prompt: 'none' }, 'consent_required'],
      ] as const) {
        const answered = await authorize(api, asked(client, challenge, overrides))
        expect(answered.binding).toBeNull()
        const back = new URL(answered.location ?? 'about:blank')
        expect(`${back.origin}${back.pathname}`).toBe(loopback)
        expect(Object.fromEntries(back.searchParams)).toMatchObject({ error, state: 'state-123', iss: origin })
      }
      // A loopback redirect may name any port (RFC 8252 §7.3).
      const otherPort = await authorize(api, asked(client, challenge, { redirect_uri: 'http://127.0.0.1:9/callback' }))
      expect(otherPort.location).toMatch(/^\/connect\/connect_/u)
    }))
})

describe('consent', () => {
  test('needs the signed-in person, in the browser that opened the request, and is decided once', () =>
    withApi(async (api) => {
      const person = await api.signIn(ada)
      const { agent } = await grantedAgent(person, ['discuss'])
      const client = await registeredClient(api)
      const { id, binding } = requestOf(await authorize(api, asked(client, pkce().challenge)))
      expect((await api.fetch(`/api/connect/${id}`, { headers: { cookie: binding } })).status).toBe(401)
      // Another browser, or a link forwarded to someone else, has no binding cookie for the request.
      expect(await consent(api, person, null).read(id)).toMatchObject({ status: 410 })
      const elsewhere = requestOf(await authorize(api, asked(client, pkce().challenge)))
      expect(await consent(api, person, elsewhere.binding).read(id)).toMatchObject({ status: 410 })
      expect(await consent(api, await api.signIn(ben), null).allow(id, agent)).toMatchObject({ status: 410 })
      const forged = await api.fetch(`/api/connect/${id}/allow`, {
        method: 'POST',
        headers: {
          origin: 'https://evil.example',
          cookie: `${person.cookie}; ${binding}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ agent }),
      })
      expect(forged.status).toBe(403)
      const refused = callbackOf(await consent(api, person, binding).refuse(id))
      expect(Object.fromEntries(refused.query)).toMatchObject({
        error: 'access_denied',
        state: 'state-123',
        iss: origin,
      })
      expect(await consent(api, person, binding).allow(id, agent)).toMatchObject({ status: 410 })
    }))

  test('lets the person pick only an agent of theirs that is not revoked and has a live grant', () =>
    withApi(async (api) => {
      const person = await api.signIn(ada)
      const stranger = await grantedAgent(await api.signIn(ben), ['discuss'])
      const ungranted = createdId(AgentId, await person.post('/api/agents', { name: 'New' }))
      const revoked = await grantedAgent(person, ['discuss'])
      await person.post(`/api/agents/${revoked.agent}/revoke`)
      const client = await registeredClient(api)
      const { id, binding } = requestOf(await authorize(api, asked(client, pkce().challenge)))
      const browser = consent(api, person, binding)
      expect(await browser.allow(id, stranger.agent)).toMatchObject({ status: 403, body: { reason: 'NotPermitted' } })
      expect(await browser.allow(id, ungranted)).toMatchObject({ status: 403, body: { reason: 'GrantExpired' } })
      expect(await browser.allow(id, revoked.agent)).toMatchObject({ status: 403, body: { reason: 'AgentRevoked' } })
      // A refused pick leaves the request waiting for a good one.
      expect((await browser.read(id)).status).toBe(200)
    }))
})

describe('client metadata documents', () => {
  const documentUrl = 'https://claude.example/oauth/client-metadata'
  const document = {
    client_id: documentUrl,
    client_name: 'Claude',
    redirect_uris: ['https://claude.example/api/mcp/auth_callback', 'javascript:alert(1)'],
    token_endpoint_auth_method: 'none',
  }

  test('identify a client by its published document, shown with its publisher', () => {
    const documents = clientDocuments({
      [documentUrl]: document,
      'https://claude.example/oauth/other-name': { ...document },
    })
    return withApi(
      async (api) => {
        const person = await api.signIn(ada)
        const { agent } = await grantedAgent(person, ['discuss'])
        const { verifier, challenge } = pkce()
        const redirect = 'https://claude.example/api/mcp/auth_callback'
        const { id, binding } = requestOf(
          await authorize(api, asked(documentUrl, challenge, { redirect_uri: redirect })),
        )
        expect(bodyOf(ConnectRequest, await consent(api, person, binding).read(id))).toMatchObject({
          client: { id: documentUrl, name: 'Claude', kind: 'published', publisher: 'claude.example' },
          redirect: { host: 'claude.example', loopback: false },
        })
        const { query } = callbackOf(await consent(api, person, binding).allow(id, agent))
        const exchange = { grant_type: 'authorization_code', code: query.get('code') ?? '', code_verifier: verifier }
        const tokens = bodyOf(Tokens, await token(api, { ...exchange, redirect_uri: redirect, client_id: documentUrl }))
        expect((await callTool(api, tokens.access_token, 'whoami')).isError).toBe(false)
        for (const parameters of [
          // A redirect the document does not list, or one it lists that is not safe.
          asked(documentUrl, challenge, { redirect_uri: 'https://claude.example/elsewhere' }),
          asked(documentUrl, challenge, { redirect_uri: 'javascript:alert(1)' }),
          // A document that names itself by another URL, and a URL that is not an https document URL.
          asked('https://claude.example/oauth/other-name', challenge, { redirect_uri: redirect }),
          asked('http://claude.example/oauth/client-metadata', challenge, { redirect_uri: redirect }),
          asked('https://127.0.0.1/oauth/client-metadata', challenge, { redirect_uri: redirect }),
        ])
          expect(await authorize(api, parameters)).toMatchObject({ status: 400, location: null })
        expect(documents.fetched).not.toContain('https://127.0.0.1/oauth/client-metadata')
      },
      signInWorld(fakeArc().client, undefined, documents.layer).layer,
    )
  })
})

describe('refresh tokens', () => {
  test('rotate on every use, and a used one presented again revokes the whole connection', () =>
    withApi(async (api) => {
      const person = await api.signIn(ada)
      const { agent } = await grantedAgent(person, ['discuss'])
      const flow = await connected(api, person, agent)
      const refresh = (refreshToken: string) =>
        token(api, { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: flow.client, resource })
      const second = bodyOf(Tokens, await refresh(flow.tokens.refresh_token))
      expect(second.refresh_token).not.toBe(flow.tokens.refresh_token)
      expect((await callTool(api, second.access_token, 'whoami')).isError).toBe(false)
      // Someone replays the first refresh token: it is refused, and every token of the connection ends.
      expect(await refresh(flow.tokens.refresh_token)).toMatchObject(invalidGrant)
      expect((await rpc(api, second.access_token, 'tools/list')).status).toBe(401)
      expect(await refresh(second.refresh_token)).toMatchObject(invalidGrant)
    }))

  test('are refused to another client, and end with revocation (RFC 7009)', () =>
    withApi(async (api) => {
      const person = await api.signIn(ada)
      const { agent } = await grantedAgent(person, ['discuss'])
      const stolen = await connected(api, person, agent)
      const thief = await registeredClient(api)
      const asThief = { grant_type: 'refresh_token', refresh_token: stolen.tokens.refresh_token, client_id: thief }
      expect(await token(api, asThief)).toMatchObject(invalidGrant)
      expect((await rpc(api, stolen.tokens.access_token, 'tools/list')).status).toBe(401)

      const flow = await connected(api, person, agent)
      const revoke = (form: Record<string, string>) =>
        api.fetch('/oauth/revoke', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(form).toString(),
        })
      expect((await revoke({ token: 'not-ours', client_id: flow.client })).status).toBe(200)
      expect((await revoke({ token: flow.tokens.access_token, client_id: flow.client })).status).toBe(200)
      expect((await rpc(api, flow.tokens.access_token, 'tools/list')).status).toBe(401)
      const refreshed = bodyOf(
        Tokens,
        await token(api, {
          grant_type: 'refresh_token',
          refresh_token: flow.tokens.refresh_token,
          client_id: flow.client,
        }),
      )
      expect((await revoke({ token: refreshed.refresh_token, client_id: flow.client })).status).toBe(200)
      expect((await rpc(api, refreshed.access_token, 'tools/list')).status).toBe(401)
    }))
})

describe('connections', () => {
  test('are listed for the person, revoked by them alone, and end every token at once', () =>
    withApi(async (api) => {
      const person = await api.signIn(ada)
      const stranger = await api.signIn(ben)
      const { agent } = await grantedAgent(person, ['discuss'])
      const flow = await connected(api, person, agent)
      const listed = connectionsOf(await person.get('/api/connections'))
      const [first] = listed
      if (first === undefined) throw new Error('No connection was listed')
      expect(listed).toEqual([
        {
          id: first.id,
          agent,
          client: { id: flow.client, name: 'Test Agent', kind: 'registered', publisher: null },
          redirect: { host: '127.0.0.1:43117', loopback: true },
          connectedAt: first.connectedAt,
        },
      ])
      expect(connectionsOf(await stranger.get('/api/connections'))).toEqual([])
      const connection = first.id
      expect((await stranger.post(`/api/connections/${connection}/revoke`)).status).toBe(404)
      expect((await callTool(api, flow.tokens.access_token, 'whoami')).isError).toBe(false)
      expect((await person.post(`/api/connections/${connection}/revoke`)).status).toBe(204)
      expect((await rpc(api, flow.tokens.access_token, 'tools/list')).status).toBe(401)
      const refresh = { grant_type: 'refresh_token', refresh_token: flow.tokens.refresh_token, client_id: flow.client }
      expect(await token(api, refresh)).toMatchObject(invalidGrant)
      expect(connectionsOf(await person.get('/api/connections'))).toEqual([])
      // OAuth's tokens are managed as connections, not listed among the tokens the person issued by hand.
      const issuedByHand = bodyOf(Page(AgentToken), await person.get(`/api/agents/${agent}/tokens`)).items
      expect(issuedByHand).toHaveLength(1)
    }))

  test('bind their tokens to this site’s /mcp: the HTTP API refuses them, and so does another resource', () => {
    const world = signInWorld(fakeArc().client)
    return withApi(async (api) => {
      const person = await api.signIn(ada)
      const { agent } = await grantedAgent(person, ['discuss'])
      const flow = await connected(api, person, agent)
      // The HTTP API admits bearer tokens through the same seam with no resource: an OAuth token is not for it.
      const viaHttpApi = await api.run(
        Effect.flip(Effect.flatMap(AgentAccess, (access) => access.admit(flow.tokens.access_token))),
      )
      expect(viaHttpApi).toMatchObject({ _tag: 'AccessDenied', reason: 'wrong_resource' })
      world.sqlite.exec(`UPDATE oauth_connections SET resource = 'https://other.example/mcp'`)
      const elsewhere = await rpc(api, flow.tokens.access_token, 'tools/list')
      expect(elsewhere.headers.get('www-authenticate')).toContain('issued for another resource')
    }, world.layer)
  })
})
