// A reference x402 seller: one paid route answering with JSON, as a Cloudflare Worker would serve it. It speaks x402
// version 2 over HTTP (the x402 Foundation's `specs/transports-v2/http.md` and `specs/schemes/exact/scheme_exact_evm.md`,
// read on 13 November 2026) with the `exact` scheme and ERC-3009, through a facilitator's `/verify` and `/settle`. It
// is written apart from Sidequest's own x402 code on purpose, so the tests that call it check one implementation
// against another. It is not deployed. Sidequest is not in its payment path: the buyer pays the seller's wallet, and
// the facilitator the seller chose settles.
//
// The flow (the `authorization` payment flow): no `PAYMENT-SIGNATURE` header, answer 402 with the challenge; a payment,
// check it names exactly this route's terms, ask the facilitator to verify it, do the work, ask the facilitator to
// settle it, and answer 200 with the work and the settlement in `PAYMENT-RESPONSE`. The work is done before settling,
// so a call that fails costs the buyer nothing.

/** What the seller charges, and how it settles. */
export interface SellerConfig {
  /** The paid route's public URL, as the challenge names it. */
  readonly resource: string
  /** CAIP-2: `eip155:<chain id>`. */
  readonly network: string
  /** The token's contract (ERC-3009 USDC). */
  readonly asset: string
  /** The token's EIP-712 domain, which the buyer's signature is over. */
  readonly token: { readonly name: string; readonly version: string }
  /** The price, in the token's atomic units. */
  readonly amount: string
  /** The seller's wallet. */
  readonly payTo: string
  /** The facilitator's base URL (its `/verify` and `/settle`). */
  readonly facilitator: string
  /** How long a signed payment stays valid. */
  readonly maxTimeoutSeconds: number
  /** The facilitator's fetch; the global one by default. */
  readonly fetch?: (request: Request) => Promise<Response>
}

type Json = null | boolean | number | string | ReadonlyArray<Json> | { readonly [key: string]: Json }

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const base64Json = (value: Json) => {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''))
}

const fromBase64Json = (header: string): unknown => {
  const decoded = Array.from(atob(header), (character) => character.charCodeAt(0))
  const parsed: unknown = JSON.parse(new TextDecoder().decode(new Uint8Array(decoded)))
  return parsed
}

/** The header's JSON, or `undefined` when it is not base64 JSON. */
const readHeader = (header: string): unknown => {
  try {
    return fromBase64Json(header)
  } catch {
    return undefined
  }
}

const requirementsOf = (config: SellerConfig) => ({
  scheme: 'exact',
  network: config.network,
  amount: config.amount,
  asset: config.asset,
  payTo: config.payTo,
  maxTimeoutSeconds: config.maxTimeoutSeconds,
  extra: { name: config.token.name, version: config.token.version },
})

const challengeOf = (config: SellerConfig, error: string) => ({
  x402Version: 2,
  error,
  resource: { url: config.resource, description: 'The weather now', mimeType: 'application/json' },
  accepts: [requirementsOf(config)],
})

const json = (body: Json, status: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  })

/** 402 with the challenge, in the `PAYMENT-REQUIRED` header as the transport requires. */
const paymentRequired = (config: SellerConfig, error: string) =>
  json({}, 402, { 'PAYMENT-REQUIRED': base64Json(challengeOf(config, error)) })

/** Whether the payment accepted exactly this route's requirements, field by field. */
const acceptsOurs = (config: SellerConfig, payment: unknown): payment is { readonly accepted: unknown } => {
  if (!isRecord(payment) || payment['x402Version'] !== 2 || !isRecord(payment['accepted'])) return false
  const accepted = payment['accepted']
  const ours = requirementsOf(config)
  return (
    accepted['scheme'] === ours.scheme &&
    accepted['network'] === ours.network &&
    accepted['amount'] === ours.amount &&
    typeof accepted['asset'] === 'string' &&
    accepted['asset'].toLowerCase() === ours.asset.toLowerCase() &&
    typeof accepted['payTo'] === 'string' &&
    accepted['payTo'].toLowerCase() === ours.payTo.toLowerCase()
  )
}

/** The facilitator's answer to `/verify` or `/settle`, or `undefined` if it did not answer JSON. */
const facilitatorCall = async (config: SellerConfig, path: string, payment: unknown) => {
  const call = config.fetch ?? ((request: Request) => fetch(request))
  const body = JSON.stringify({ x402Version: 2, paymentPayload: payment, paymentRequirements: requirementsOf(config) })
  const response = await call(
    new Request(`${config.facilitator}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    }),
  )
  const answer: unknown = await response.json().catch(() => undefined)
  return isRecord(answer) ? answer : undefined
}

/** The paid work: here, a fixed forecast. */
const work = (): Json => ({ place: 'Ljubljana', forecast: 'sunny', temperatureC: 14 })

type Answer = Readonly<Record<string, unknown>> | undefined

/** A text field of the facilitator's answer, or `fallback`. */
const textOf = (answer: Answer, key: string, fallback: string) => {
  const value = answer?.[key]
  return typeof value === 'string' ? value : fallback
}

/** Settling failed: 402 again, with the challenge and the failed settlement. */
const notSettled = (config: SellerConfig, settled: Answer) => {
  const errorReason = textOf(settled, 'errorReason', 'unexpected_settle_error')
  const failure = { success: false, errorReason, transaction: '', network: config.network }
  return json({}, 402, {
    'PAYMENT-REQUIRED': base64Json(challengeOf(config, errorReason)),
    'PAYMENT-RESPONSE': base64Json(failure),
  })
}

/** The seller's handler for its one paid route. */
export const seller =
  (config: SellerConfig) =>
  async (request: Request): Promise<Response> => {
    const header = request.headers.get('PAYMENT-SIGNATURE')
    if (header === null) return paymentRequired(config, 'PAYMENT-SIGNATURE header is required')
    const payment = readHeader(header)
    if (!acceptsOurs(config, payment)) return json({ error: 'invalid_payment_requirements' }, 400)
    const verified = await facilitatorCall(config, '/verify', payment)
    if (verified?.['isValid'] !== true) return paymentRequired(config, textOf(verified, 'invalidReason', 'unverified'))
    const result = work()
    const settled = await facilitatorCall(config, '/settle', payment)
    if (settled?.['success'] !== true) return notSettled(config, settled)
    const response = {
      success: true,
      transaction: textOf(settled, 'transaction', ''),
      network: config.network,
      payer: textOf(settled, 'payer', ''),
    }
    return json(result, 200, { 'PAYMENT-RESPONSE': base64Json(response) })
  }

/** The Worker's variables: the terms and the facilitator, all plain text. */
export interface SellerEnvironment {
  readonly RESOURCE_URL: string
  readonly NETWORK: string
  readonly ASSET: string
  readonly TOKEN_NAME: string
  readonly TOKEN_VERSION: string
  readonly AMOUNT: string
  readonly PAY_TO: string
  readonly FACILITATOR_URL: string
}

export default {
  fetch: (request: Request, environment: SellerEnvironment) =>
    seller({
      resource: environment.RESOURCE_URL,
      network: environment.NETWORK,
      asset: environment.ASSET,
      token: { name: environment.TOKEN_NAME, version: environment.TOKEN_VERSION },
      amount: environment.AMOUNT,
      payTo: environment.PAY_TO,
      facilitator: environment.FACILITATOR_URL,
      maxTimeoutSeconds: 300,
    })(request),
}
