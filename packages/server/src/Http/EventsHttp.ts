import {
  type AgentGrantView,
  EventInvalid,
  EventTooLarge,
  KindNotIndexed,
  NotIndexed,
  type Person,
  SidequestApi,
  type WalletLink,
} from '@sidequest/protocol'
import { Effect, Option } from 'effect'
import * as HttpEffect from 'effect/http/HttpEffect'
import { HttpServerRequest } from 'effect/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import { HttpApiBuilder } from 'effect/http-api'
import { grantStatus, type WalletLinkRow } from '../Index/Derived.ts'
import type { Known, KnownGrant } from '../Index/EventStore.ts'
import { EventStore } from '../Index/EventStore.ts'
import { Ingest, nowSeconds } from '../Index/Ingest.ts'
import { Outbox } from '../Index/Outbox.ts'
import { publishLimits, RateLimiter } from '../Index/RateLimiter.ts'
import { type EventRefused, validateEvent } from '../Index/Validation.ts'

/** A response anyone, and any cache, may keep for `seconds`. */
const publicFor = (seconds: number, immutable = false) =>
  HttpEffect.appendPreResponseHandler((_, response) =>
    Effect.succeed(
      HttpServerResponse.setHeader(
        response,
        'cache-control',
        `public, max-age=${seconds}${immutable ? ', immutable' : ''}`,
      ),
    ),
  )

/** The index's refusal as the API's: too large, a kind it does not keep, or invalid and why. */
const refusalOf = ({ reason, kind }: EventRefused) => {
  if (reason === 'tooLarge') return new EventTooLarge()
  if (reason === 'unknownKind') return new KindNotIndexed({ kind: kind ?? -1 })
  return new EventInvalid({ reason })
}

/**
 * The client's address as Cloudflare saw it. The edge forwards the request's headers to the API unchanged, and
 * Cloudflare sets `CF-Connecting-IP` on every request it receives, replacing any a client sent. Without it (a request
 * that did not come through Cloudflare, such as the tests'), every such client shares one bucket.
 */
const clientAddress = (request: HttpServerRequest) => request.headers['cf-connecting-ip'] ?? 'unknown'

const walletOf = ({ account, eventId, issuedAt, verification }: WalletLinkRow): WalletLink => ({
  account,
  event: eventId,
  issuedAt,
  verification,
})

const grantViewOf =
  (now: number) =>
  (grant: KnownGrant): AgentGrantView => ({
    event: grant.eventId,
    operator: grant.operator,
    agent: grant.agent,
    scopes: grant.scopes,
    notBefore: grant.notBefore,
    expiresAt: grant.expiresAt,
    label: grant.label,
    status: grantStatus(grant, now),
  })

const personOf = (pubkey: string, known: Known, now: number): typeof Person.Type => ({
  pubkey,
  profile: Option.getOrNull(
    Option.map(known.profile, ({ name, about, picture, eventId, createdAt }) => ({
      name,
      about,
      picture,
      event: eventId,
      createdAt,
    })),
  ),
  relays: Option.getOrNull(
    Option.map(known.relayList, ({ read, write, eventId, createdAt }) => ({ read, write, event: eventId, createdAt })),
  ),
  messagingRelays: Option.getOrNull(
    Option.map(known.messagingRelays, ({ read, eventId, createdAt }) => ({ relays: read, event: eventId, createdAt })),
  ),
  wallets: known.wallets.map(walletOf),
  unverifiedWallets: known.unverifiedWallets.map(walletOf),
  agents: known.agents.map(grantViewOf(now)),
  operators: known.operators.map(grantViewOf(now)),
})

const nothingKnown = (known: Known) =>
  Option.isNone(known.profile) &&
  Option.isNone(known.relayList) &&
  Option.isNone(known.messagingRelays) &&
  known.wallets.length === 0 &&
  known.unverifiedWallets.length === 0 &&
  known.agents.length === 0 &&
  known.operators.length === 0

/** An EVM account as wallet links spell it: in lowercase, so `eip155:1:0xAbC…` finds the same wallet. */
const linkSpelling = (account: string) => (account.startsWith('eip155:') ? account.toLowerCase() : account)

/**
 * The `events` group: publish-through and the index's public reads.
 *
 * Publishing takes one signed event from anyone, with no session and no cookie: the event's signature is its
 * authority. The group is added to `SidequestApi` after its `SameOrigin` middleware, so that middleware never runs
 * here, and this is the only group so placed. That is safe because nothing ambient is used: no cookie, session or
 * other credential a browser attaches is read, so a page on another site that makes a browser post an event achieves
 * only what the event's author could do by posting it themselves. What limits abuse is the rate limiter: per client
 * address before anything is checked, and per key once the signature verified (a forged key spends no one's quota).
 */
export const eventsHandlers = HttpApiBuilder.group(SidequestApi, 'events', (handlers) =>
  Effect.gen(function* () {
    const ingest = yield* Ingest
    const events = yield* EventStore
    const limiter = yield* RateLimiter
    const outbox = yield* Outbox
    return handlers
      .handle('publish', ({ payload }) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest
          yield* limiter.take(`ip:${clientAddress(request)}`, publishLimits.perClient)
          const validated = yield* validateEvent(payload).pipe(Effect.mapError(refusalOf))
          yield* limiter.take(`key:${validated.event.pubkey}`, publishLimits.perKey)
          const accepted = yield* ingest.store(validated, 'publish')
          yield* outbox.enqueue(accepted.event)
          return { id: accepted.event.id, status: accepted.status }
        }),
      )
      .handle('event', ({ params }) =>
        Effect.gen(function* () {
          const found = yield* events.find(params.id)
          if (Option.isNone(found)) return yield* new NotIndexed()
          // An event's id is the hash of all it says: what this URL answers never changes.
          yield* publicFor(31_536_000, true)
          return found.value
        }),
      )
      .handle('person', ({ params }) =>
        Effect.gen(function* () {
          const known = yield* events.known(params.pubkey)
          if (nothingKnown(known)) return yield* new NotIndexed()
          yield* publicFor(60)
          return personOf(params.pubkey, known, yield* nowSeconds)
        }),
      )
      .handle('wallet', ({ params }) =>
        Effect.gen(function* () {
          const linked = yield* events.wallet(linkSpelling(params.account))
          if (Option.isNone(linked)) return yield* new NotIndexed()
          yield* publicFor(60)
          return { ...walletOf(linked.value), pubkey: linked.value.pubkey }
        }),
      )
  }),
)
