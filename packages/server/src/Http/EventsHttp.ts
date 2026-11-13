import {
  type AgentGrantView,
  type Erc8004Identity,
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
import { Erc8004Identities } from '../Erc8004/Identities.ts'
import { grantStatus, type WalletLinkRow } from '../Index/Derived.ts'
import type { Known, KnownGrant } from '../Index/EventStore.ts'
import { EventStore } from '../Index/EventStore.ts'
import { Ingest, nowSeconds } from '../Index/Ingest.ts'
import { Jobs } from '../Index/Jobs.ts'
import { Listings } from '../Index/Listings.ts'
import { PayPerCall } from '../Index/PayPerCall.ts'
import { labelled, Moderation } from '../Index/Moderation.ts'
import { Outbox } from '../Index/Outbox.ts'
import { RateLimiter } from '@sidequest/serving/RateLimiter'
import { publishLimits } from '../Index/PublishLimits.ts'
import { type EventRefused, validateEvent } from '../Index/Validation.ts'

/** A response anyone, and any cache, may keep for `seconds`. */
export const publicFor = (seconds: number, immutable = false) =>
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
export const clientAddress = (request: HttpServerRequest) => request.headers['cf-connecting-ip'] ?? 'unknown'

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

const personOf = (
  pubkey: string,
  known: Known,
  now: number,
  erc8004: ReadonlyArray<Erc8004Identity>,
): typeof Person.Type => ({
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
  erc8004,
})

const nothingKnown = (known: Known, erc8004: ReadonlyArray<Erc8004Identity>) =>
  erc8004.length === 0 &&
  Option.isNone(known.profile) &&
  Option.isNone(known.relayList) &&
  Option.isNone(known.messagingRelays) &&
  known.wallets.length === 0 &&
  known.unverifiedWallets.length === 0 &&
  known.agents.length === 0 &&
  known.operators.length === 0

/** An EVM account as wallet links spell it: in lowercase, so `eip155:1:0xAbC…` finds the same wallet. */
const linkSpelling = (account: string) => (account.startsWith('eip155:') ? account.toLowerCase() : account)

/** A listing's receipts; one turns verified when the chain log poller records its transaction, so caches keep seconds. */
const receiptsOf = (payPerCall: PayPerCall['Service'], params: { readonly pubkey: string; readonly slug: string }) =>
  Effect.gen(function* () {
    const items = yield* payPerCall.receipts(params.pubkey, params.slug)
    yield* publicFor(10)
    return { items }
  })

/**
 * The `events` group: publish-through and the index's public reads.
 *
 * Publishing takes one signed event from anyone: the event's signature is its authority, and nothing ambient (no
 * cookie, no session, no credential a browser attaches) is read, so any origin may send one (see `SidequestApi`). What
 * limits abuse is the rate limiter: per client address before anything is checked, and per key once the signature
 * verified (a forged key spends no one's quota).
 */
export const eventsHandlers = HttpApiBuilder.group(SidequestApi, 'events', (handlers) =>
  Effect.gen(function* () {
    const ingest = yield* Ingest
    const events = yield* EventStore
    const limiter = yield* RateLimiter
    const outbox = yield* Outbox
    const listings = yield* Listings
    const payPerCall = yield* PayPerCall
    const jobs = yield* Jobs
    const moderation = yield* Moderation
    const identities = yield* Erc8004Identities
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
          // An event's id is the hash of all it says, so the event never changes; whether it is hidden can, and a
          // takedown must reach caches within the hour, so it is cached for that long and not for a year.
          yield* labelled(yield* moderation.covers([found.value.id, found.value.pubkey]))
          yield* publicFor(3600)
          return found.value
        }),
      )
      .handle('person', ({ params }) =>
        Effect.gen(function* () {
          const known = yield* events.known(params.pubkey)
          const erc8004 = yield* identities.of(params.pubkey)
          if (nothingKnown(known, erc8004)) return yield* new NotIndexed()
          yield* labelled(yield* moderation.covers([params.pubkey]))
          yield* publicFor(60)
          return personOf(params.pubkey, known, yield* nowSeconds, erc8004)
        }),
      )
      .handle('personJobs', ({ params }) =>
        Effect.gen(function* () {
          const items = yield* jobs.ofParty(params.pubkey)
          // A key's jobs change with each request or proposal it signs: caches keep the answer for seconds only.
          yield* publicFor(10)
          return { items }
        }),
      )
      .handle('people', ({ query }) =>
        Effect.gen(function* () {
          const people = yield* events.names(query.pubkeys)
          yield* publicFor(60)
          return { people }
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
      .handle('listings', ({ query }) =>
        Effect.gen(function* () {
          const page = yield* listings.search(query)
          yield* publicFor(30)
          return page
        }),
      )
      .handle('listing', ({ params }) =>
        Effect.gen(function* () {
          const found = yield* listings.get(params.pubkey, params.slug)
          if (Option.isNone(found)) return yield* new NotIndexed()
          yield* labelled(yield* moderation.covers([found.value.event, params.pubkey]))
          yield* publicFor(30)
          return found.value
        }),
      )
      .handle('listingReceipts', ({ params }) => receiptsOf(payPerCall, params))
  }),
)
