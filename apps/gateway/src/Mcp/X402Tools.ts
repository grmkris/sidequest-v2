import type { PublicKey } from '@sidequest/nostr'
import { paymentReceipt, PaymentReceiptContent } from '@sidequest/nostr/vocabulary'
import {
  type AccountRef,
  type Bytes32,
  exactAuthorization,
  exactPaymentPayload,
  exactTypedData,
  type IndexListingDetail,
  matchChallenge,
  webCrypto,
  x402Header,
  X402PaymentRequired,
} from '@sidequest/protocol'
import { nowSeconds } from '@sidequest/serving/Authorize'
import { Crypto, Effect, Option, Result, Schema } from 'effect'
import { Core } from '../Core/Core.ts'
import type { Admitted } from '../Grants/GrantGate.ts'
import { ChallengeFetch } from '../X402/ChallengeFetch.ts'
import { acting, publishAs, refusedByCore } from './Acting.ts'
import { Refused } from './Tools.ts'

// The x402 rail's tools (ADR-0006). The agent finds a pay-per-call listing, asks its resource for the price and gets
// back what its operator's wallet must sign; after the operator paid, it publishes the receipt. It never pays: the
// agent's key holds no money, and there is no `pay` scope until Nod's spending delegations exist.

interface ListingInput {
  readonly seller: PublicKey
  readonly slug: string
}

const warning =
  'A paid call has no escrow, no review, no dispute and no refund. Sidequest checked only that the challenge asks ' +
  'what the listing says and that its payTo is the seller’s verified wallet; it holds nothing and is not in the ' +
  'payment path.'

/** A pay-per-call listing whose payTo is its seller's verified wallet, or why not. */
const paidListingOf = Effect.fnUntraced(function* (input: ListingInput) {
  const core = yield* Core
  const found = yield* core.listing(input.seller, input.slug).pipe(Effect.mapError(refusedByCore))
  if (Option.isNone(found)) return yield* new Refused({ reason: 'UnknownListing' })
  const listing: IndexListingDetail = found.value
  if (listing.payPerCall === null || listing.price === null) return yield* new Refused({ reason: 'NotPayPerCall' })
  if (!listing.payPerCall.payToLinked)
    return yield* new Refused({
      reason: 'PayToNotLinked',
      detail: 'The listing’s payTo is not its seller’s verified wallet now: do not pay it.',
    })
  return {
    seller: input.seller,
    slug: listing.slug,
    version: listing.event,
    resource: listing.payPerCall.resource,
    amount: listing.price.amount,
    asset: listing.price.asset,
    payTo: listing.payPerCall.payTo,
  }
})

/** The operator's verified wallet on the asset's network: who pays, and whose payment the receipt names. */
const payerOf = Effect.fnUntraced(function* (admitted: Admitted, asset: string) {
  const core = yield* Core
  const network = asset.slice(0, asset.indexOf('/'))
  const person = yield* core.person(admitted.operator).pipe(Effect.mapError(refusedByCore))
  const wallet = Option.flatMap(person, ({ wallets }) =>
    Option.fromNullishOr(wallets.find(({ account }) => account.startsWith(`${network}:`))),
  )
  if (Option.isNone(wallet))
    return yield* new Refused({
      reason: 'NoWalletOnNetwork',
      detail: `Your operator has no verified wallet link on ${network}.`,
    })
  return wallet.value.account
})

const readChallenge = Schema.decodeUnknownOption(x402Header(X402PaymentRequired))

/** 32 random bytes as `0x` hex: an ERC-3009 nonce. */
const freshNonce = Effect.map(
  Crypto.Crypto.use((crypto) => crypto.randomBytes(32)),
  (bytes) => `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`,
).pipe(Effect.orDie, Effect.provideService(Crypto.Crypto, webCrypto))

export const x402Quote = Effect.fnUntraced(function* (input: ListingInput) {
  const admitted = yield* acting(null)
  const listing = yield* paidListingOf(input)
  const payer: AccountRef = yield* payerOf(admitted, listing.asset)
  const answered = yield* (yield* ChallengeFetch).ask(listing.resource)
  if (Option.isNone(answered)) return yield* new Refused({ reason: 'ResourceUnreachable' })
  const challenge =
    answered.value.status === 402 ? Option.flatMap(answered.value.challenge, readChallenge) : Option.none()
  if (Option.isNone(challenge))
    return yield* new Refused({ reason: 'NoChallenge', detail: `The resource answered ${answered.value.status}.` })
  const matched = matchChallenge(listing, challenge.value)
  if (Result.isFailure(matched))
    return yield* new Refused({ reason: 'ChallengeMismatch', detail: matched.failure.reason })
  const offer = matched.success
  const now = yield* nowSeconds
  const validBefore = now + offer.requirements.maxTimeoutSeconds
  const authorization = exactAuthorization(offer, payer.slice(payer.lastIndexOf(':') + 1), {
    nonce: yield* freshNonce,
    validAfter: now - 60,
    validBefore,
  })
  return {
    listing,
    payer,
    typedData: exactTypedData(offer, authorization),
    payment: exactPaymentPayload(challenge.value, offer, authorization, ''),
    validBefore,
    warning,
  }
})

export const x402Receipt = Effect.fnUntraced(function* (input: ListingInput & { readonly transaction: Bytes32 }) {
  const admitted = yield* acting('accept')
  const listing = yield* paidListingOf(input)
  const payer = yield* payerOf(admitted, listing.asset)
  const content = yield* Schema.decodeUnknownEffect(PaymentReceiptContent)({
    listing: `30402:${listing.seller}:${listing.slug}`,
    version: listing.version,
    resource: listing.resource,
    payer,
    amount: listing.amount,
    asset: listing.asset,
    transaction: input.transaction,
  }).pipe(Effect.mapError(() => new Refused({ reason: 'NotPayPerCall', detail: 'The listing reads as no receipt.' })))
  const signed = yield* publishAs(admitted, paymentReceipt, content)
  return { receipt: signed.id, listing, payer, signedBy: signed.signedBy, grant: signed.grant }
})
