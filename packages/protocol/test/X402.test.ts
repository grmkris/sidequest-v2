import { Result, Schema } from 'effect'
import { describe, expect, test } from 'vitest'
import {
  x402Header,
  X402ExactEvmPayload,
  X402PaymentPayload,
  X402PaymentRequired,
  X402Settlement,
} from '../src/X402.ts'
import {
  erc3009AuthorizationFields,
  exactAuthorization,
  exactPaymentPayload,
  exactTypedData,
  matchChallenge,
  type PayPerCallTerms,
} from '../src/X402Exact.ts'
import vectors from './vectors/x402-http.json' with { type: 'json' }

// The x402 v2 HTTP transport's own examples (vectors/x402-http.json, copied from the specification) read as the
// specification says they decode, and the buyer's side of `exact` on EVM matches a challenge against its listing.

const readRequired = Schema.decodeUnknownSync(x402Header(X402PaymentRequired))
const readPayload = Schema.decodeUnknownSync(x402Header(X402PaymentPayload))
const readSettlement = Schema.decodeUnknownSync(x402Header(X402Settlement))

describe('the x402 v2 HTTP headers, from the specification’s examples', () => {
  test('PAYMENT-REQUIRED decodes to the challenge the specification shows', () => {
    const challenge = readRequired(vectors.paymentRequired)
    expect(challenge).toMatchObject({
      x402Version: 2,
      resource: { url: 'https://api.example.com/premium-data' },
      accepts: [
        {
          scheme: 'exact',
          network: 'eip155:84532',
          amount: '10000',
          asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
          payTo: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
          maxTimeoutSeconds: 60,
          extra: { name: 'USDC', version: '2' },
        },
      ],
    })
  })

  test('PAYMENT-SIGNATURE decodes to an exact EVM payload with an ERC-3009 authorization', () => {
    const payment = readPayload(vectors.paymentSignature)
    const payload = Schema.decodeUnknownSync(X402ExactEvmPayload)(payment.payload)
    expect(payload.authorization).toEqual({
      from: '0x857b06519E91e3A54538791bDbb0E22373e36b66',
      to: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
      value: '10000',
      validAfter: '1740672089',
      validBefore: '1740672154',
      nonce: '0xf3746613c2d920b5fdabc0856f2aeb2d4f88ee6037b8cc5d04a71a4462f13480',
    })
  })

  test('PAYMENT-RESPONSE decodes a settlement and a failure', () => {
    expect(readSettlement(vectors.paymentResponse)).toMatchObject({ success: true, network: 'eip155:84532' })
    expect(readSettlement(vectors.paymentResponseFailed)).toMatchObject({
      success: false,
      errorReason: 'insufficient_funds',
      transaction: '',
    })
  })

  test('a header written here reads back the same', () => {
    const challenge = readRequired(vectors.paymentRequired)
    const written = Schema.encodeSync(x402Header(X402PaymentRequired))(challenge)
    expect(readRequired(written)).toEqual(challenge)
  })

  test.each(['', 'not base64!', btoa('{"x402Version":1,"accepts":[]}'), btoa('{"x402Version":2,"accepts":[]}')])(
    'refuses a malformed or other-version challenge: %s',
    (header) =>
      expect(Result.isFailure(Schema.decodeUnknownResult(x402Header(X402PaymentRequired))(header))).toBe(true),
  )
})

const terms: PayPerCallTerms = {
  resource: 'https://api.example.com/premium-data',
  payTo: 'eip155:84532:0x209693bc6afc0c5328ba36faf03c514ef312287c',
  amount: '10000',
  asset: 'eip155:84532/erc20:0x036cbd53842c5426634e7929541ec2318f3dcf7e',
}

const reasonOf = (listing: PayPerCallTerms, challenge = readRequired(vectors.paymentRequired)) =>
  Result.match(matchChallenge(listing, challenge), { onSuccess: () => 'matched', onFailure: ({ reason }) => reason })

describe('matching a challenge against its listing', () => {
  test('the specification’s challenge matches a listing of the same terms, whatever the letter case', () =>
    expect(reasonOf(terms)).toBe('matched'))

  test.each([
    ['payTo', { payTo: 'eip155:84532:0x0000000000000000000000000000000000000001' }],
    ['amount', { amount: '9999' }],
    ['amount', { amount: '10001' }],
    ['asset', { asset: 'eip155:84532/erc20:0x0000000000000000000000000000000000000002' }],
    ['noExactOffer', { asset: 'eip155:5042002/erc20:0x036cbd53842c5426634e7929541ec2318f3dcf7e' }],
    ['resource', { resource: 'https://elsewhere.example.com/premium-data' }],
  ] as const)('refuses a challenge whose %s differs from the listing', (reason, change) =>
    expect(reasonOf({ ...terms, ...change })).toBe(reason),
  )

  test('refuses another transfer method, a missing token domain and a long timeout', () => {
    const challenge = readRequired(vectors.paymentRequired)
    const offer = challenge.accepts[0]
    if (offer === undefined) throw new Error('The example has an offer')
    const changed = (change: Partial<typeof offer>) => ({ ...challenge, accepts: [{ ...offer, ...change }] })
    expect(reasonOf(terms, changed({ extra: { name: 'USDC', version: '2', assetTransferMethod: 'permit2' } }))).toBe(
      'transferMethod',
    )
    expect(reasonOf(terms, changed({ extra: { name: 'USDC' } }))).toBe('tokenDomain')
    expect(reasonOf(terms, changed({ maxTimeoutSeconds: 86_401 }))).toBe('timeout')
  })

  test('the authorization to sign pays the offer’s amount to its payTo, on the token’s EIP-712 domain', () => {
    const challenge = readRequired(vectors.paymentRequired)
    const offer = Result.getOrThrow(matchChallenge(terms, challenge))
    const nonce = `0x${'11'.repeat(32)}`
    const authorization = exactAuthorization(offer, '0x857b06519E91e3A54538791bDbb0E22373e36b66', {
      nonce,
      validAfter: 1_740_672_089,
      validBefore: 1_740_672_154,
    })
    expect(exactTypedData(offer, authorization)).toEqual({
      domain: {
        name: 'USDC',
        version: '2',
        chainId: 84_532,
        verifyingContract: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      },
      types: { TransferWithAuthorization: [...erc3009AuthorizationFields] },
      primaryType: 'TransferWithAuthorization',
      message: {
        from: '0x857b06519E91e3A54538791bDbb0E22373e36b66',
        to: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
        value: '10000',
        validAfter: '1740672089',
        validBefore: '1740672154',
        nonce,
      },
    })
    const signature = `0x${'22'.repeat(65)}`
    const payment = exactPaymentPayload(challenge, offer, authorization, signature)
    expect(readPayload(Schema.encodeSync(x402Header(X402PaymentPayload))(payment))).toEqual({
      x402Version: 2,
      resource: challenge.resource,
      accepted: offer.requirements,
      payload: { signature, authorization },
    })
  })
})
