import { expect } from 'bun:test'
import { Entropy, finalizeEvent, httpAuthHeader, httpAuthTemplate, type NostrEvent, PublicKey } from '@sidequest/nostr'
import type { SecretKey } from '@sidequest/nostr'
import { buildSidequestEvent, type KindSpec } from '@sidequest/nostr/vocabulary'
import { textDigest } from '@sidequest/protocol'
import { Effect, Schema } from 'effect'
import { Base64Url } from 'effect/encoding'
import { McpClient, McpProtocol } from 'effect/ai'

// What an operator and an MCP client do at the agent gateway over its public surfaces, shared by the gateway's
// acceptance test and the events rehearsal: NIP-98 requests as the operator's signer would sign them, the OAuth
// connection an MCP client makes with the operator's consent, and the MCP client itself.

const now = () => Math.floor(Date.now() / 1000)
const entropy = () => crypto.getRandomValues(new Uint8Array(32))

/** A Sidequest event `key` signs, as the operator's own signer would. */
export const signedBy = async <C>(key: SecretKey, spec: KindSpec<C>, content: C): Promise<NostrEvent> => {
  const template = await Effect.runPromise(buildSidequestEvent(spec, content, { createdAt: now() }))
  return finalizeEvent(template, key, Schema.decodeSync(Entropy)(entropy()))
}

/** A request to the gateway carrying `key`'s NIP-98 authorization of exactly it. */
export const authorized = async (
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

export const json = async (response: Response): Promise<unknown> => response.json()
const Created = Schema.Struct({ agent: PublicKey })
const Registered = Schema.Struct({ client_id: Schema.String })
const Decision = Schema.Struct({ redirect: Schema.String })
const Tokens = Schema.Struct({ access_token: Schema.String, refresh_token: Schema.String })

/** The operator makes an agent labelled `label` at the gateway; answers its public key. */
export const createAgent = async (gatewayUrl: string, operator: SecretKey, label: string) => {
  const created = await authorized(operator, `${gatewayUrl}/api/agents`, 'POST', JSON.stringify({ label }))
  expect(created.status).toBe(201)
  return Schema.decodeUnknownSync(Created)(await json(created)).agent
}

/** The operator connects an MCP client to `agent` over OAuth: registration, authorization, consent, the token. */
export const connectOverOAuth = async (gatewayUrl: string, operator: SecretKey, agent: string) => {
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

/** An MCP client at the gateway's `/mcp`, with the access token the operator's consent gave. */
export const mcpClient = (gatewayUrl: string, accessToken: string) =>
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
