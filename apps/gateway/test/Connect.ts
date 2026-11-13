import { createHash, randomBytes } from 'node:crypto'
import type { PublicKey, SecretKey } from '@sidequest/nostr'
import { Schema } from 'effect'
import { type Gateway, loopback, nip98, origin } from './GatewayWorld.ts'

// An MCP client's side of the gateway: OAuth (registration, authorization, the operator's consent in their browser,
// the token exchange) and then MCP's JSON-RPC at `/mcp`, by hand so the wire is the test's own.

const Registered = Schema.Struct({ client_id: Schema.String })
export const Tokens = Schema.Struct({
  access_token: Schema.String,
  token_type: Schema.Literal('Bearer'),
  expires_in: Schema.Number,
  refresh_token: Schema.String,
})

/** A PKCE verifier and its S256 challenge, from Node's crypto, never the server's code. */
const pkcePair = () => {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

const form = (gateway: Gateway, path: string, fields: Record<string, string>) =>
  gateway.fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  })

/** A client registers itself and the browser opens its authorization request: the consent page and binding cookie. */
export const startConnecting = async (gateway: Gateway) => {
  const registered = await gateway.fetch('/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Test client', redirect_uris: [loopback] }),
  })
  const client = Schema.decodeUnknownSync(Registered)(await registered.json()).client_id
  const { verifier, challenge } = pkcePair()
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: client,
    redirect_uri: loopback,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'st',
    resource: `${origin}/mcp`,
  })
  const authorized = await gateway.fetch(`/oauth/authorize?${query.toString()}`, { redirect: 'manual' })
  const consent = authorized.headers.get('location') ?? ''
  const cookie = (authorized.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
  return { client, verifier, consent, cookie }
}

/** The operator allows `agent` on the consent page, signing the request with `key`; the gateway's answer. */
export const allow = async (
  gateway: Gateway,
  key: SecretKey,
  consent: string,
  cookie: string,
  agent: PublicKey,
  at?: number,
) => {
  const body = JSON.stringify({ agent })
  const path = `${consent}/allow`
  const response = await gateway.fetch(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie,
      authorization: nip98(key, `${origin}${path}`, 'POST', body, at),
    },
    body,
  })
  return {
    status: response.status,
    body: Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(await response.json()),
  }
}

/** Trades a code (or a refresh token) at the token endpoint. */
export const exchange = (gateway: Gateway, fields: Record<string, string>) => form(gateway, '/oauth/token', fields)

/** The whole flow: `key`'s operator connects a client to `agent`; the client's id, verifier and tokens. */
export const connect = async (gateway: Gateway, key: SecretKey, agent: PublicKey) => {
  const { client, verifier, consent, cookie } = await startConnecting(gateway)
  const allowed = await allow(gateway, key, consent, cookie, agent)
  const code = new URL(String(allowed.body['redirect'])).searchParams.get('code') ?? ''
  const exchanged = await exchange(gateway, {
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    redirect_uri: loopback,
    client_id: client,
  })
  return { client, code, verifier, tokens: Schema.decodeUnknownSync(Tokens)(await exchanged.json()) }
}

const ToolResult = Schema.Struct({
  result: Schema.Struct({
    isError: Schema.optional(Schema.Boolean),
    structuredContent: Schema.optional(Schema.Unknown),
    content: Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.String })),
  }),
})

/** One MCP request as revision 2026-07-28 sends it; the HTTP status and the JSON-RPC message. */
export const mcp = async (gateway: Gateway, token: string | undefined, method: string, params: object = {}) => {
  const response = await gateway.fetch('/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': method,
      ...('name' in params && typeof params.name === 'string' ? { 'mcp-name': params.name } : {}),
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 7,
      method,
      params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': {},
          'io.modelcontextprotocol/clientInfo': { name: 'gateway-test', version: '1' },
        },
      },
    }),
  })
  const text = await response.text()
  const data = text.includes('data:')
    ? (
        text
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .at(-1) ?? ''
      ).slice(5)
    : text
  const message: unknown = data.trim() === '' ? null : JSON.parse(data)
  return { status: response.status, headers: response.headers, message }
}

/** A tool's result: its structured content on success, or its refusal (the `Refused` error) on failure. */
export const tool = async (gateway: Gateway, token: string, name: string, args: object = {}) => {
  const { message } = await mcp(gateway, token, 'tools/call', { name, arguments: args })
  const { result } = Schema.decodeUnknownSync(ToolResult)(message)
  return result.isError === true
    ? {
        ok: false as const,
        refusal: Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(result.content[0]?.text ?? 'null'),
      }
    : { ok: true as const, value: result.structuredContent }
}
