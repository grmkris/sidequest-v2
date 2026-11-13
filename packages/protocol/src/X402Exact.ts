import { Predicate, Result, Schema } from 'effect'
import type { TypedData } from './TypedData.ts'
import {
  type X402Authorization,
  type X402PaymentPayload,
  type X402PaymentRequired,
  type X402Requirements,
  x402Version,
} from './X402.ts'

// The `exact` scheme on EVM with ERC-3009, from the buyer's side: does a seller's challenge ask exactly what its
// listing says, and what must the buyer's wallet sign to pay it. Pure and browser-safe.

/**
 * What a pay-per-call listing promises, as a challenge must meet it: the resource's URL, the CAIP-10 account paid
 * (`eip155:<chain>:0x…`), the price in atomic units and the CAIP-19 asset (`eip155:<chain>/erc20:0x…`).
 */
export interface PayPerCallTerms {
  readonly resource: string
  readonly payTo: string
  readonly amount: string
  readonly asset: string
}

/** Why a challenge does not match its listing: the buyer must not sign it. */
export const ChallengeMismatchReason = Schema.Literals([
  'noExactOffer',
  'resource',
  'asset',
  'payTo',
  'amount',
  'transferMethod',
  'tokenDomain',
  'timeout',
])
export type ChallengeMismatchReason = typeof ChallengeMismatchReason.Type

export class ChallengeMismatch extends Schema.TaggedError<ChallengeMismatch>()('ChallengeMismatch', {
  reason: ChallengeMismatchReason,
}) {}

/** The one offer in a challenge the buyer may pay, with what signing it needs. */
export interface ExactOffer {
  readonly requirements: X402Requirements
  readonly chainId: number
  /** The token contract: the EIP-712 domain's `verifyingContract`. */
  readonly token: string
  /** The token's EIP-712 domain name and version, as the seller states them in `extra`. */
  readonly domain: { readonly name: string; readonly version: string }
}

/** The longest authorization window a buyer signs for: a day. A seller asking for more is refused. */
export const maxAuthorizationSeconds = 86_400

const lower = (value: string) => value.toLowerCase()
const after = (value: string, separator: string) => value.slice(value.lastIndexOf(separator) + separator.length)
const originOf = (url: string) => (URL.canParse(url) ? new URL(url).origin : undefined)

const textIn = (extra: X402Requirements['extra'], key: string): string | undefined => {
  const value = extra?.[key]
  return Predicate.isString(value) ? value : undefined
}

/** The first mismatch of an offer on the listing's network and token, if any. */
const mismatchOf = (terms: PayPerCallTerms, offer: X402Requirements): ChallengeMismatchReason | undefined => {
  const method = textIn(offer.extra, 'assetTransferMethod')
  if (lower(offer.payTo) !== lower(after(terms.payTo, ':'))) return 'payTo'
  if (offer.amount !== terms.amount) return 'amount'
  if (method !== undefined && method !== 'eip3009') return 'transferMethod'
  if (textIn(offer.extra, 'name') === undefined || textIn(offer.extra, 'version') === undefined) return 'tokenDomain'
  if (offer.maxTimeoutSeconds < 1 || offer.maxTimeoutSeconds > maxAuthorizationSeconds) return 'timeout'
  return undefined
}

/**
 * The offer in `challenge` that pays exactly what `terms` say, or why there is none: an `exact` offer on the asset's
 * network and token, to the listing's `payTo`, for exactly its price, by ERC-3009, naming the token's EIP-712 domain,
 * with a timeout of at most a day, for a resource on the listing's origin. Addresses compare in any letter case.
 */
export const matchChallenge = (
  terms: PayPerCallTerms,
  challenge: X402PaymentRequired,
): Result.Result<ExactOffer, ChallengeMismatch> => {
  const fail = (reason: ChallengeMismatchReason) => Result.fail(new ChallengeMismatch({ reason }))
  const network = terms.asset.slice(0, terms.asset.indexOf('/'))
  const token = after(terms.asset, ':')
  const listed = originOf(terms.resource)
  if (listed === undefined || originOf(challenge.resource.url) !== listed) return fail('resource')
  const offers = challenge.accepts.filter((offer) => offer.scheme === 'exact' && offer.network === network)
  if (offers.length === 0) return fail('noExactOffer')
  const offer = offers.find((candidate) => lower(candidate.asset) === lower(token))
  if (offer === undefined) return fail('asset')
  const mismatch = mismatchOf(terms, offer)
  if (mismatch !== undefined) return fail(mismatch)
  return Result.succeed({
    requirements: offer,
    chainId: Number(after(network, ':')),
    token: offer.asset,
    domain: { name: textIn(offer.extra, 'name') ?? '', version: textIn(offer.extra, 'version') ?? '' },
  })
}

/** ERC-3009's `TransferWithAuthorization` struct, which the `exact` scheme's `eip3009` method signs. */
const transferWithAuthorizationTypes = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
}

/**
 * The authorization a buyer's wallet signs to pay `offer` from `from`: the offer's amount to its `payTo`, valid from
 * `validAfter` until `validBefore` (Unix seconds), under a fresh random 32-byte `nonce` the caller supplies.
 */
export const exactAuthorization = (
  offer: ExactOffer,
  from: string,
  window: { readonly nonce: string; readonly validAfter: number; readonly validBefore: number },
): X402Authorization => ({
  from,
  to: offer.requirements.payTo,
  value: offer.requirements.amount,
  validAfter: String(window.validAfter),
  validBefore: String(window.validBefore),
  nonce: window.nonce,
})

/** The EIP-712 typed data of `authorization` on the offer's token, for `eth_signTypedData_v4`. */
export const exactTypedData = (offer: ExactOffer, authorization: X402Authorization): TypedData => ({
  domain: { ...offer.domain, chainId: offer.chainId, verifyingContract: offer.token },
  types: transferWithAuthorizationTypes,
  primaryType: 'TransferWithAuthorization',
  message: { ...authorization },
})

/** The `PaymentPayload` of a signed authorization, for the `PAYMENT-SIGNATURE` header of the paid retry. */
export const exactPaymentPayload = (
  challenge: X402PaymentRequired,
  offer: ExactOffer,
  authorization: X402Authorization,
  signature: string,
): X402PaymentPayload => ({
  x402Version,
  resource: challenge.resource,
  accepted: offer.requirements,
  payload: { signature, authorization },
})
