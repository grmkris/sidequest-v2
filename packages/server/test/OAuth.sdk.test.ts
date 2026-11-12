import {
  Client,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from '@modelcontextprotocol/client'
import { describe, expect, test } from 'vitest'
import { ada, type Api, origin, withApi } from './HttpWorld.ts'
import { grantedAgent, inProcessFetch } from './McpWorld.ts'
import { callbackOf, consent, loopback, requestOf } from './OAuthWorld.ts'

// The official MCP TypeScript SDK client (`@modelcontextprotocol/client` 2.4.0) connecting with nothing but the
// server's URL: it reads the 401, discovers the metadata, registers itself, sends the person to authorize with PKCE,
// trades the code (checking `iss`) and calls tools with its token. Proves the server interoperates with the reference
// client, not only with tests written against it.

/** An SDK client's OAuth state, kept in memory, which "opens the browser" by recording the authorization URL. */
class MemoryProvider implements OAuthClientProvider {
  information: StoredOAuthClientInformation | undefined
  saved: StoredOAuthTokens | undefined
  verifier = ''
  opened: URL | undefined
  get redirectUrl() {
    return loopback
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'SDK interop',
      redirect_uris: [loopback],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }
  }
  clientInformation() {
    return this.information
  }
  saveClientInformation(information: StoredOAuthClientInformation) {
    this.information = information
  }
  tokens() {
    return this.saved
  }
  saveTokens(tokens: StoredOAuthTokens) {
    this.saved = tokens
  }
  redirectToAuthorization(url: URL) {
    this.opened = url
  }
  saveCodeVerifier(verifier: string) {
    this.verifier = verifier
  }
  codeVerifier() {
    return this.verifier
  }
}

const transportFor = (api: Api, provider: MemoryProvider) =>
  new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { authProvider: provider, fetch: inProcessFetch(api) })

describe('the official MCP SDK client', () => {
  test('connects over OAuth from the server URL alone, as the agent the person picks', () =>
    withApi(async (api) => {
      const person = await api.signIn(ada)
      const { agent } = await grantedAgent(person, ['discuss'])
      const provider = new MemoryProvider()
      const first = transportFor(api, provider)
      await expect(new Client({ name: 'sdk-oauth', version: '1' }).connect(first)).rejects.toBeInstanceOf(
        UnauthorizedError,
      )
      const opened = provider.opened
      if (opened === undefined) throw new Error('The SDK never sent the person to authorize')
      expect(opened.origin).toBe(origin)
      expect(opened.searchParams.get('code_challenge_method')).toBe('S256')
      expect(opened.searchParams.get('resource')).toBe(`${origin}/mcp`)
      // The person's browser follows the authorization URL, and they allow it on the consent page.
      const authorized = await api.fetch(`${opened.pathname}${opened.search}`, { redirect: 'manual' })
      const binding = /^(__Host-sidequest-connect=[0-9a-f]{64});/u.exec(authorized.headers.get('set-cookie') ?? '')
      const { id } = requestOf({
        status: authorized.status,
        location: authorized.headers.get('location'),
        binding: binding?.[1] ?? null,
        body: '',
      })
      const callback = callbackOf(await consent(api, person, binding?.[1] ?? null).allow(id, agent))
      await first.finishAuth(callback.query)

      const client = new Client({ name: 'sdk-oauth', version: '1' })
      await client.connect(transportFor(api, provider))
      const called = await client.callTool({ name: 'whoami', arguments: {} })
      expect(called.structuredContent).toMatchObject({ account: person.account, agent: { id: agent } })
      await client.close()
      expect(provider.saved?.refresh_token).toMatch(/^sqr_/u)
    }))
})
