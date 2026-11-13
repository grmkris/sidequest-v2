import { createHash, randomBytes } from 'node:crypto'
import {
  finalizeEvent,
  freshEntropy,
  httpAuthHeader,
  httpAuthTemplate,
  type NostrEvent,
  PublicKey,
  publicKeyOf,
  SecretKey,
} from '@sidequest/nostr'
import { agentGrant, buildSidequestEvent, grantRevocation, type KindSpec } from '@sidequest/nostr/vocabulary'
import { type GrantScope, NetworkRef, webCrypto } from '@sidequest/protocol'
import { ClientDocuments } from '@sidequest/serving/ClientDocuments'
import { localSqlOf } from '@sidequest/serving/test/LocalSql'
import { Crypto, Effect, Layer, Redacted, Schema } from 'effect'
import { HttpRouter, HttpServer } from 'effect/http'
import { GatewaySecret } from '../src/Keys/KeyEnvelope.ts'
import { gatewayRoutes } from '../src/Routes.ts'
import { GatewaySettings } from '../src/Settings.ts'
import { type CoreDouble, coreDouble } from './CoreDouble.ts'
import { type MemoryRooms, memoryRooms } from './MemoryRooms.ts'

// The gateway in process: its routes over a fresh local D1 (its own migrations), with the core as an in-memory double.
// Operators are keys the test holds; they sign NIP-98 authorizations and grant events here, as a browser's signer would.

export const origin = 'https://gateway.test'
export const secret = Redacted.make(Schema.decodeSync(GatewaySecret)('5e'.repeat(32)))
export const loopback = 'http://127.0.0.1:43117/callback'

const sign = (template: Parameters<typeof finalizeEvent>[0], key: SecretKey): NostrEvent =>
  Effect.runSync(
    Effect.map(freshEntropy, (entropy) => finalizeEvent(template, key, entropy)).pipe(
      Effect.provideService(Crypto.Crypto, webCrypto),
    ),
  )

/** A fresh key, as a person's signer holds it. */
export const freshKey = () => Schema.decodeSync(SecretKey)(randomBytes(32).toString('hex'))

const now = () => Math.floor(Date.now() / 1000)

/** The unsigned Sidequest event of `spec`, made now. */
const templateOf = <C>(spec: KindSpec<C>, content: C, network?: string) =>
  buildSidequestEvent(spec, content, {
    createdAt: now(),
    ...(network === undefined ? {} : { network: Schema.decodeSync(NetworkRef)(network) }),
  }).pipe(Effect.orDie)

/** A Sidequest event of `spec`, signed by `key`. */
export const signed = <C>(spec: KindSpec<C>, content: C, key: SecretKey, network?: string) =>
  sign(Effect.runSync(templateOf(spec, content, network)), key)

/** A Sidequest event whose content check is asynchronous (a proposal's terms digest), signed by `key`. */
export const signedLater = async <C>(spec: KindSpec<C>, content: C, key: SecretKey, network?: string) =>
  sign(await Effect.runPromise(templateOf(spec, content, network)), key)

/** What a gateway request answered: its status, headers and body (JSON when it is JSON). */
export interface Reply {
  readonly status: number
  readonly headers: Headers
  readonly body: unknown
}

const replyOf = async (response: Response): Promise<Reply> => {
  const text = await response.text()
  const json = text.startsWith('{') || text.startsWith('[')
  return { status: response.status, headers: response.headers, body: json ? JSON.parse(text) : text }
}

export interface Gateway {
  readonly core: CoreDouble
  /** The relays and inbox lists room tools reach. */
  readonly rooms: MemoryRooms
  readonly fetch: (path: string, init?: RequestInit) => Promise<Response>
  readonly sqlite: ReturnType<typeof localSqlOf>['sqlite']
  /** A request with the operator's NIP-98 authorization of exactly it. */
  readonly asOperator: (key: SecretKey, method: string, path: string, body?: unknown) => Promise<Reply>
  readonly createAgent: (key: SecretKey, label?: string) => Promise<PublicKey>
  /** The operator signs a grant for `agent` and publishes it through the core; answers the grant event. */
  readonly grant: (
    key: SecretKey,
    agent: PublicKey,
    scopes: ReadonlyArray<GrantScope>,
    window?: { readonly notBefore?: number; readonly expiresAt?: number },
  ) => Promise<NostrEvent>
  readonly revoke: (key: SecretKey, grant: NostrEvent) => void
}

/**
 * The second a test signs NIP-98 authorizations at: the wall clock's when made, then moved only by `tick`. Two
 * authorizations of one request signed at one second are one event, which the gateway spends once; the test decides
 * when that holds instead of hoping two signatures fall in the same wall-clock second. The gateway accepts
 * authorizations within a minute of its own clock, far longer than a test runs.
 */
export const signingClock = () => {
  let at = now()
  return {
    now: () => at,
    tick: () => {
      at += 1
    },
  }
}

/** The NIP-98 header of a request, signed by `key` at `at` (now). */
export const nip98 = (key: SecretKey, url: string, method: string, body?: string, at = now()) =>
  httpAuthHeader(
    sign(
      httpAuthTemplate(
        {
          url,
          method,
          ...(body === undefined ? {} : { payloadSha256: createHash('sha256').update(body).digest('hex') }),
        },
        at,
      ),
      key,
    ),
  )

/** Run `test` against a fresh gateway. `grantCacheSeconds` is the grant gate's window (0: read the core every call). */
export const withGateway = async (test: (gateway: Gateway) => Promise<void>, grantCacheSeconds = 0) => {
  const core = coreDouble()
  const rooms = memoryRooms()
  const { sqlite, layer: sql } = localSqlOf(new URL('../migrations/', import.meta.url))
  const settings = Layer.succeed(GatewaySettings, {
    coreUrl: 'https://core.test',
    secret,
    grantCacheSeconds,
    release: 'test',
  })
  const documents = Layer.succeed(ClientDocuments, { fetch: () => Effect.succeedNone })
  const world = Layer.mergeAll(sql, settings, core.layer, documents, rooms.layer)
  const { handler, dispose } = HttpRouter.toWebHandler(
    gatewayRoutes('test').pipe(Layer.provide(world), Layer.provide(HttpServer.layerServices)),
    { disableLogger: true },
  )
  const fetch = (path: string, init?: RequestInit) => handler(new Request(`${origin}${path}`, init))
  const asOperator = async (key: SecretKey, method: string, path: string, body?: unknown) => {
    const text = body === undefined ? undefined : JSON.stringify(body)
    const headers: Record<string, string> = { authorization: nip98(key, `${origin}${path}`, method, text) }
    if (text !== undefined) headers['content-type'] = 'application/json'
    return replyOf(await fetch(path, { method, headers, ...(text === undefined ? {} : { body: text }) }))
  }
  const publish = (event: NostrEvent) => {
    core.events.push(event)
  }
  try {
    await test({
      core,
      rooms,
      fetch,
      sqlite,
      asOperator,
      createAgent: async (key, label = 'Scout') => {
        const reply = await asOperator(key, 'POST', '/api/agents', { label })
        return Schema.decodeUnknownSync(Schema.Struct({ agent: PublicKey }))(reply.body).agent
      },
      grant: async (key, agent, scopes, window = {}) => {
        const content = {
          agent,
          scopes: [...scopes],
          notBefore: window.notBefore ?? now() - 60,
          expiresAt: window.expiresAt ?? now() + 3600,
          label: 'Scout',
        }
        const event = signed(agentGrant, content, key)
        publish(event)
        return event
      },
      revoke: (key, grant) => {
        const content = { grant: grant.id }
        publish(signed(grantRevocation, content, key))
      },
    })
  } finally {
    await dispose()
  }
}

/** The operator's public key: who they are. */
export const operatorOf = (key: SecretKey) => publicKeyOf(key)
