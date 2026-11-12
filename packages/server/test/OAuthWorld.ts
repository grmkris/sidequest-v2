import { createHash, randomBytes } from 'node:crypto'
import { ConnectDecision } from '@sidequest/protocol'
import { Schema } from 'effect'
import { type Api, bodyOf, origin, type Person, type Reply } from './HttpWorld.ts'

// OAuth as an MCP client and a person's browser use it, over the in-process API: the client registers (or names its
// metadata document), sends the person's browser to authorize, the signed-in person consents on the website, and the
// client trades the code for tokens. PKCE is computed here with Node's own crypto, never with the server's code.

export const resource = `${origin}/mcp`
export const loopback = 'http://127.0.0.1:43117/callback'

/** A PKCE pair (RFC 7636): a random verifier and its S256 challenge. */
export const pkce = () => {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

const replyOf = async (response: Response): Promise<Reply & { readonly headers: Headers }> => {
  const text = await response.text()
  const body: unknown = text === '' ? null : text.startsWith('{') ? JSON.parse(text) : text
  return { status: response.status, body, headers: response.headers }
}

/** Dynamic client registration, as an MCP client sends it. */
export const register = async (api: Api, metadata: Record<string, unknown>) =>
  replyOf(
    await api.fetch('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(metadata),
    }),
  )

/** A public client registered for `redirect`, its id. */
export const registeredClient = async (api: Api, redirect = loopback, name = 'Test Agent') => {
  const reply = await register(api, {
    client_name: name,
    redirect_uris: [redirect],
    token_endpoint_auth_method: 'none',
  })
  return bodyOf(Schema.Struct({ client_id: Schema.String }), reply).client_id
}

/** What the authorization endpoint answered the browser: where it sends it, and the cookie binding the request. */
export interface Authorized {
  readonly status: number
  readonly location: string | null
  readonly binding: string | null
  readonly body: string
}

/** The browser opens the authorization URL a client built (`parameters`; `null` leaves one out). */
export const authorize = async (api: Api, parameters: Record<string, string | null>): Promise<Authorized> => {
  const query = new URLSearchParams()
  for (const [name, value] of Object.entries(parameters)) if (value !== null) query.append(name, value)
  const response = await api.fetch(`/oauth/authorize?${query.toString()}`, { redirect: 'manual' })
  const cookie = /^(__Host-sidequest-connect=[0-9a-f]{64});/u.exec(response.headers.get('set-cookie') ?? '')
  return {
    status: response.status,
    location: response.headers.get('location'),
    binding: cookie?.[1] ?? null,
    body: await response.text(),
  }
}

/** The usual parameters of a client's authorization request. */
export const asked = (client: string, challenge: string, overrides: Record<string, string | null> = {}) => ({
  response_type: 'code',
  client_id: client,
  redirect_uri: loopback,
  code_challenge: challenge,
  code_challenge_method: 'S256',
  state: 'state-123',
  resource,
  ...overrides,
})

/** The consent page's request id, from where authorization sent the browser. */
export const requestOf = (authorized: Authorized) => {
  const id = /^\/connect\/(connect_[0-9A-Z]{26})$/u.exec(authorized.location ?? '')?.[1]
  if (id === undefined || authorized.binding === null)
    throw new Error(`Authorization did not wait for consent: ${authorized.status} ${authorized.body}`)
  return { id, binding: authorized.binding }
}

/** The consent API as the person's browser calls it: their session cookie and the request's binding cookie. */
export const consent = (api: Api, person: Person, binding: string | null) => {
  const cookie = binding === null ? person.cookie : `${person.cookie}; ${binding}`
  const send = async (method: string, path: string, body?: unknown) =>
    replyOf(
      await api.fetch(path, {
        method,
        headers: { origin, cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  return {
    read: (request: string) => send('GET', `/api/connect/${request}`),
    allow: (request: string, agent: string) => send('POST', `/api/connect/${request}/allow`, { agent }),
    refuse: (request: string) => send('POST', `/api/connect/${request}/refuse`),
  }
}

/** The code, state and issuer a decision sends the browser back to the client with. */
export const callbackOf = (reply: Reply) => {
  const { redirect } = bodyOf(ConnectDecision, reply)
  return { url: redirect, query: new URL(redirect).searchParams }
}

/** The token endpoint, as a public client posts its form. */
export const token = async (api: Api, form: Record<string, string>) =>
  replyOf(
    await api.fetch('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    }),
  )

export const Tokens = Schema.Struct({
  access_token: Schema.String,
  token_type: Schema.Literal('Bearer'),
  expires_in: Schema.Number,
  refresh_token: Schema.String,
})

/** The whole flow for `person`'s `agent` through a registered client: its id, the PKCE pair and the tokens. */
export const connected = async (api: Api, person: Person, agent: string) => {
  const client = await registeredClient(api)
  const { verifier, challenge } = pkce()
  const { id, binding } = requestOf(await authorize(api, asked(client, challenge)))
  const { query } = callbackOf(await consent(api, person, binding).allow(id, agent))
  const code = query.get('code') ?? ''
  const exchange = { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: loopback }
  const tokens = bodyOf(Tokens, await token(api, { ...exchange, client_id: client, resource }))
  return { client, code, verifier, tokens }
}
