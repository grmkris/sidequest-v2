import { expect } from 'bun:test'
import {
  type AccountId,
  Cursor,
  InboxEntry,
  JobId,
  JobView,
  ListingId,
  Message,
  ProposalId,
  type ProposalRef,
  RoomRef,
  SessionView,
  SignInChallenge,
  UsdcOnArcTestnet,
} from '@sidequest/protocol'
import { Entropy, finalizeEvent, publicKeyOf, SecretKey } from '@sidequest/nostr'
import { profileTemplate } from '@sidequest/nostr/vocabulary'
import { DateTime, Effect, Schedule, Schema } from 'effect'
import * as HttpClient from 'effect/http/HttpClient'
import type * as HttpClientError from 'effect/http/HttpClientError'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'
import type * as HttpClientResponse from 'effect/http/HttpClientResponse'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

// People and their requests through the deployed edge, for the native acceptance tests: signed-in clients, bounded
// reads of what follows eventually, and the negotiation two people run before a hire.

/** POST `body` as JSON to `url`, with no session. */
export const postJson = (url: string, body: unknown) =>
  HttpClient.execute(HttpClientRequest.post(url).pipe(HttpClientRequest.bodyJsonUnsafe(body)))

/** Sign a generated key in through the edge: ask for a challenge, sign it, send it back. */
export const signIn = (url: string, wallet: ReturnType<typeof privateKeyToAccount>) =>
  Effect.gen(function* () {
    const challenge = yield* postJson(`${url}/api/session/challenge`, { address: wallet.address })
    expect(challenge.status).toBe(200)
    const { message } = yield* Effect.flatMap(challenge.json, Schema.decodeUnknownEffect(SignInChallenge))
    const signature = yield* Effect.promise(() => wallet.signMessage({ message }))
    return { message, signature, response: yield* postJson(`${url}/api/session/verify`, { message, signature }) }
  })

/** One person's requests through the edge: JSON, from the site's origin, with their session cookie. */
export const browserOf = (url: string, cookie: string) => {
  const send = (request: HttpClientRequest.HttpClientRequest, body?: unknown) =>
    HttpClient.execute(
      (body === undefined ? request : HttpClientRequest.bodyJsonUnsafe(request, body)).pipe(
        HttpClientRequest.setHeaders({ cookie, origin: url }),
      ),
    )
  return {
    get: (path: string) => send(HttpClientRequest.get(`${url}${path}`)),
    post: (path: string, body?: unknown) => send(HttpClientRequest.post(`${url}${path}`), body),
    put: (path: string, body: unknown) => send(HttpClientRequest.put(`${url}${path}`), body),
  }
}

/** A signed-in person: their requests, their account and the session cookie they hold. */
type Browser = ReturnType<typeof browserOf> & { readonly account: AccountId; readonly cookie: string }

/** Sign a fresh wallet in and keep its session cookie. */
export const signedIn = (url: string) =>
  Effect.gen(function* () {
    const { response } = yield* signIn(url, privateKeyToAccount(generatePrivateKey()))
    const cookie = (response.headers['set-cookie'] ?? '').split('; ')[0] ?? ''
    const { account } = yield* Effect.flatMap(response.json, Schema.decodeUnknownEffect(SessionView))
    const browser: Browser = { ...browserOf(url, cookie), account, cookie }
    return browser
  })

/** What a bounded read fails with while the answer it waits for has not arrived. */
export class NotYet extends Schema.TaggedError<NotYet>()('NotYet', {}) {}

/**
 * Read until the answer decodes and `done` holds: Durable Objects commit at once, but views and D1 projections follow
 * eventually. A bounded retry, every 100 ms for at most 20 seconds, never a fixed sleep.
 */
export const until = <A>(
  read: Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError, HttpClient.HttpClient>,
  schema: Schema.Decoder<A>,
  done: (value: A) => boolean = () => true,
) =>
  read.pipe(
    Effect.flatMap((response) => response.json),
    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
    Effect.flatMap((value) => (done(value) ? Effect.succeed(value) : Effect.fail(new NotYet()))),
    Effect.retry({ schedule: Schedule.spaced('100 millis'), times: 200 }),
  )

/** The id a command that creates something answered with; a command is sent once, never retried. */
export const createdBy = <A>(
  send: Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError, HttpClient.HttpClient>,
  id: Schema.Decoder<A>,
) =>
  send.pipe(
    Effect.flatMap((response) => response.json),
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ id }))),
    Effect.map((created) => created.id),
  )

/** A fresh key's kind-0 profile with `name`, signed now: what a Nostr client publishes. */
export const signedProfile = (name: string) => {
  const key = Schema.decodeSync(SecretKey)(generatePrivateKey().slice(2))
  const createdAt = Math.floor(Date.now() / 1000)
  const event = finalizeEvent(profileTemplate(name, createdAt), key, Schema.decodeSync(Entropy)(new Uint8Array(32)))
  return { event, pubkey: publicKeyOf(key) }
}

/** One day, in seconds. */
export const day = 86_400

/** Terms for a logo at `amount`, escrowed in USDC on Arc testnet. */
const offer = (amount: string) => ({
  title: 'A logo',
  deliverables: ['SVG logo'],
  amount,
  asset: UsdcOnArcTestnet.id,
  network: UsdcOnArcTestnet.network,
  deliveryDeadline: Math.floor(Date.now() / 1000) + 30 * day,
  reviewWindowSeconds: 3 * day,
  disputeWindowSeconds: 2 * day,
  arbitrationWindowSeconds: 7 * day,
  rail: 'escrow',
})

/** The versions the buyer's view of `job` names, once it holds `count`. */
const proposalsFor = (buyer: Browser, job: string, count: number) =>
  until(
    buyer.get(`/api/jobs/${job}`),
    JobView,
    (shown) => shown.audience === 'buyer' && shown.view.proposals.length === count,
  ).pipe(
    Effect.map((shown): ReadonlyArray<ProposalRef> =>
      shown.audience === 'buyer'
        ? shown.view.proposals.map(({ bidder, version, termsDigest }) => ({ bidder, version, termsDigest }))
        : [],
    ),
  )

/** A job's rooms, as the API lists them. */
export const Rooms = Schema.Struct({ rooms: Schema.Array(RoomRef) })
/** A room's messages, as the API lists them. */
export const Messages = Schema.Struct({ messages: Schema.Array(Message) })
/** A page of a person's inbox. */
export const Inbox = Schema.Struct({ items: Schema.Array(InboxEntry), next: Cursor })
/** The kinds of the entries on an inbox page, in order. */
export const kindsIn = (inbox: typeof Inbox.Type) => inbox.items.map(({ kind }) => kind)

/** Ben offers logos, Ada posts a request; Ben proposes, Ada asks for a change, Ben proposes again. */
export const negotiate = (ada: Browser, ben: Browser) =>
  Effect.gen(function* () {
    const listing = yield* createdBy(
      ben.post('/api/listings', { title: 'Logos', description: 'By hand.', tags: ['logo'] }),
      ListingId,
    )
    const now = Math.floor(DateTime.toEpochMillis(yield* DateTime.now) / 1000)
    const posted = { title: 'A logo for my café', description: 'Warm.', expiresAt: now + 7 * day }
    const job = yield* createdBy(ada.post('/api/jobs', posted), JobId)
    yield* createdBy(ben.post(`/api/jobs/${job}/proposals`, { terms: offer('250000000') }), ProposalId)
    const [v1] = yield* proposalsFor(ada, job, 1)
    expect((yield* ada.post(`/api/jobs/${job}/change-requests`, v1)).status).toBe(204)
    yield* createdBy(ben.post(`/api/jobs/${job}/proposals`, { previous: 1, terms: offer('300000000') }), ProposalId)
    const [first, second] = yield* proposalsFor(ada, job, 2)
    return { listing, job, first, second }
  })
