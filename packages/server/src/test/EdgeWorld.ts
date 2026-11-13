import { Terms, termsDigest as digestOfTerms, UsdcOnArcTestnet } from '@sidequest/protocol'
import { Entropy, finalizeEvent, publicKeyOf, SecretKey } from '@sidequest/nostr'
import { buildSidequestEvent, jobProposal, jobRequest, profileTemplate } from '@sidequest/nostr/vocabulary'
import { Clock, Effect, Schedule, Schema } from 'effect'
import * as HttpClient from 'effect/http/HttpClient'
import type * as HttpClientError from 'effect/http/HttpClientError'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'
import type * as HttpClientResponse from 'effect/http/HttpClientResponse'
import { generatePrivateKey } from 'viem/accounts'

// Requests through the deployed edge, for the native acceptance tests: signed events to publish, and bounded reads of
// what follows eventually.

/** POST `body` as JSON to `url`. */
export const postJson = (url: string, body: unknown) =>
  HttpClient.execute(HttpClientRequest.post(url).pipe(HttpClientRequest.bodyJsonUnsafe(body)))

/** What a bounded read fails with while the answer it waits for has not arrived. */
export class NotYet extends Schema.TaggedError<NotYet>()('NotYet', {}) {}

/**
 * Read until the answer decodes and `done` holds: what the index derives, and what the chain and relays bring, follows
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

/** A request by a fresh key, and a proposal for it by another, both signed now. */
export const signedRequestAndProposal = Effect.gen(function* () {
  const zeros = yield* Schema.decodeEffect(Entropy)(new Uint8Array(32))
  const buyer = yield* Schema.decodeEffect(SecretKey)(generatePrivateKey().slice(2))
  const bidder = yield* Schema.decodeEffect(SecretKey)(generatePrivateKey().slice(2))
  const createdAt = Math.floor((yield* Clock.currentTimeMillis) / 1000)
  const content = { title: 'A logo', description: 'Small, warm.', expiresAt: createdAt + 7 * day }
  const request = finalizeEvent(yield* buildSidequestEvent(jobRequest, content, { createdAt }), buyer, zeros)
  const terms = yield* Schema.decodeUnknownEffect(Terms)(offer('100000000'))
  const bid = yield* Schema.decodeUnknownEffect(jobProposal.content)({
    job: request.id,
    buyer: request.pubkey,
    terms: yield* Schema.encodeEffect(Terms)(terms),
    termsDigest: yield* digestOfTerms(terms),
    payTo: `${UsdcOnArcTestnet.network}:0x${publicKeyOf(bidder).slice(0, 40)}`,
    validUntil: createdAt + 3 * day,
  })
  const proposal = finalizeEvent(yield* buildSidequestEvent(jobProposal, bid, { createdAt }), bidder, zeros)
  return { request, proposal }
})
