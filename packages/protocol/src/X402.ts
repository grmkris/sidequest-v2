import { Schema } from 'effect'

// x402 version 2's wire format over HTTP, as far as Sidequest reads and writes it: the `PaymentRequired` challenge a
// seller's resource answers with 402, the `PaymentPayload` a buyer sends back, and the `SettlementResponse` the seller
// answers once paid, each a base64-encoded JSON header. Written against the x402 Foundation's specification
// (`specs/x402-specification-v2.md`, `specs/transports-v2/http.md`, `specs/schemes/exact/scheme_exact_evm.md` at
// github.com/x402-foundation/x402 commit 1a08434, read on 13 November 2026), not an x402 package. Only the `exact`
// scheme on EVM with an ERC-3009 `transferWithAuthorization` is built; anything else a seller offers is read and
// passed over. Browser-safe: no chain library.

/** The protocol version this module speaks. */
export const x402Version = 2

/** The three headers of x402 over HTTP (`transports-v2/http.md`). */
export const x402Headers = {
  required: 'PAYMENT-REQUIRED',
  signature: 'PAYMENT-SIGNATURE',
  response: 'PAYMENT-RESPONSE',
} as const

/** `ResourceInfo`: what the protected resource is. Only `url` is required. */
export const X402Resource = Schema.Struct({
  url: Schema.String.check(Schema.isMaxLength(2048)),
  description: Schema.optionalKey(Schema.String),
  mimeType: Schema.optionalKey(Schema.String),
  serviceName: Schema.optionalKey(Schema.String),
})
export type X402Resource = typeof X402Resource.Type

/**
 * `PaymentRequirements`: one way the seller accepts payment. Read loosely, as any scheme's: whether it is one Sidequest
 * can pay is `matchChallenge`'s question. `extra` is scheme-specific (for `exact` on EVM with ERC-3009: the token's
 * EIP-712 domain `name` and `version`, and optionally `assetTransferMethod`).
 */
export const X402Requirements = Schema.Struct({
  scheme: Schema.String,
  network: Schema.String,
  amount: Schema.String,
  asset: Schema.String,
  payTo: Schema.String,
  maxTimeoutSeconds: Schema.Int,
  extra: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
})
export type X402Requirements = typeof X402Requirements.Type

/** `PaymentRequired`: the seller's challenge, the `PAYMENT-REQUIRED` header of a 402. */
export const X402PaymentRequired = Schema.Struct({
  x402Version: Schema.Literal(x402Version),
  error: Schema.optionalKey(Schema.String),
  resource: X402Resource,
  accepts: Schema.Array(X402Requirements).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  extensions: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
})
export type X402PaymentRequired = typeof X402PaymentRequired.Type

const Hex = (bytes: number) => Schema.String.check(Schema.isPattern(new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`, 'u')))
const EvmAddress = Hex(20)
const Uint = Schema.String.check(Schema.isPattern(/^(0|[1-9][0-9]{0,77})$/u))

/** ERC-3009's `TransferWithAuthorization` parameters, integers as decimal strings. */
export const X402Authorization = Schema.Struct({
  from: EvmAddress,
  to: EvmAddress,
  value: Uint,
  validAfter: Uint,
  validBefore: Uint,
  nonce: Hex(32),
})
export type X402Authorization = typeof X402Authorization.Type

/** The `exact` scheme's EVM payload with the `eip3009` transfer method: the authorization and its signature. */
export const X402ExactEvmPayload = Schema.Struct({
  signature: Schema.String.check(Schema.isPattern(/^0x(?:[0-9a-fA-F]{2}){65,4096}$/u)),
  authorization: X402Authorization,
})
export type X402ExactEvmPayload = typeof X402ExactEvmPayload.Type

/** `PaymentPayload`: the buyer's payment, the `PAYMENT-SIGNATURE` header of the paid retry. */
export const X402PaymentPayload = Schema.Struct({
  x402Version: Schema.Literal(x402Version),
  resource: Schema.optionalKey(X402Resource),
  accepted: X402Requirements,
  payload: Schema.Record(Schema.String, Schema.Unknown),
  extensions: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
})
export type X402PaymentPayload = typeof X402PaymentPayload.Type

/** `SettlementResponse`: what the seller answers about settling, the `PAYMENT-RESPONSE` header. */
export const X402Settlement = Schema.Struct({
  success: Schema.Boolean,
  errorReason: Schema.optionalKey(Schema.String),
  errorMessage: Schema.optionalKey(Schema.String),
  payer: Schema.optionalKey(Schema.String),
  transaction: Schema.String,
  network: Schema.String,
  amount: Schema.optionalKey(Schema.String),
})
export type X402Settlement = typeof X402Settlement.Type

/** A header's value: the base64 of the object's JSON, as every x402 HTTP header carries it. */
export const x402Header = <S extends Schema.Codec<unknown, unknown>>(schema: S) =>
  Schema.StringFromBase64.pipe(Schema.decodeTo(Schema.fromJsonString(schema)))
