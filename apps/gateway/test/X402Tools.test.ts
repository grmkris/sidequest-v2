import { publicKeyOf } from '@sidequest/nostr'
import { envelopeTag, paymentReceipt } from '@sidequest/nostr/vocabulary'
import {
  AccountRef,
  type IndexListingDetail,
  UsdcOnArcTestnet,
  x402Header,
  X402PaymentRequired,
  type GrantScope,
} from '@sidequest/protocol'
import { Schema } from 'effect'
import { describe, expect, test } from 'vitest'
import { connect, tool } from './Connect.ts'
import { eventsOfKind } from './CoreDouble.ts'
import { isResourceUrl } from '../src/X402/ChallengeFetch.ts'
import { freshKey, type Gateway, withGateway } from './GatewayWorld.ts'

// The x402 tools against the core double and a seller's resource in process: the quote reads the 402 challenge, checks
// it against the listing and answers what the operator's wallet must sign; the receipt is signed with the agent's key
// under its grant. The agent never pays.

const resource = 'https://weather.example.com/now'
const sellerAddress = `0x${'5e'.repeat(20)}`
const sellerWallet = Schema.decodeSync(AccountRef)(`${UsdcOnArcTestnet.network}:${sellerAddress}`)
const operatorWallet = Schema.decodeSync(AccountRef)(`${UsdcOnArcTestnet.network}:0x${'ab'.repeat(20)}`)
const token = UsdcOnArcTestnet.id.slice(UsdcOnArcTestnet.id.lastIndexOf(':') + 1)

const listingOf = (seller: string, change: Partial<IndexListingDetail> = {}): IndexListingDetail => ({
  pubkey: seller,
  slug: 'weather',
  event: 'f5'.repeat(32),
  createdAt: 1_800_000_000,
  title: 'Weather now',
  summary: 'The weather, as JSON.',
  description: 'One call, one forecast.',
  topics: ['weather'],
  price: { amount: '10000', asset: UsdcOnArcTestnet.id },
  network: UsdcOnArcTestnet.network,
  status: 'active',
  publishedAt: 1_800_000_000,
  author: { name: 'Bea', walletVerified: true },
  rail: 'x402',
  payPerCall: { resource, payTo: sellerWallet, payToLinked: true, verifiedReceipts: 0 },
  ...change,
})

/** A seller's resource answering 402 with an exact offer of `amount` to `payTo`. */
const sellerAsking =
  (amount = '10000', payTo = sellerAddress, status = 402) =>
  async () => {
    const challenge = Schema.encodeSync(x402Header(X402PaymentRequired))({
      x402Version: 2,
      resource: { url: resource },
      accepts: [
        {
          scheme: 'exact',
          network: UsdcOnArcTestnet.network,
          amount,
          asset: token,
          payTo,
          maxTimeoutSeconds: 120,
          extra: { name: 'USDC', version: '2' },
        },
      ],
    })
    return new Response('{}', { status, headers: { 'PAYMENT-REQUIRED': challenge } })
  }

/** An operator with a verified wallet, their agent granted `scopes`, and a seller's listing in the core. */
const setUp = async (gateway: Gateway, scopes: ReadonlyArray<GrantScope>) => {
  const operatorKey = freshKey()
  const agent = await gateway.createAgent(operatorKey)
  const grant = await gateway.grant(operatorKey, agent, scopes)
  gateway.core.wallets.set(publicKeyOf(operatorKey), [operatorWallet])
  const { tokens } = await connect(gateway, operatorKey, agent)
  const seller = publicKeyOf(freshKey())
  gateway.core.listings.set(`${seller}/weather`, listingOf(seller))
  gateway.resources.set(resource, sellerAsking())
  const call = (name: string, args: object = {}) => tool(gateway, tokens.access_token, name, args)
  return { agent, grant, seller, call }
}

describe('the x402 tools', () => {
  test('x402_quote answers the authorization the operator’s wallet signs, for exactly the listing’s terms', () =>
    withGateway(async (gateway) => {
      const { seller, call } = await setUp(gateway, ['discuss'])
      const quote = await call('x402_quote', { seller, slug: 'weather' })
      expect(quote).toMatchObject({
        ok: true,
        value: {
          listing: { resource, amount: '10000', payTo: sellerWallet },
          payer: operatorWallet,
          typedData: {
            domain: { name: 'USDC', version: '2', chainId: 5_042_002, verifyingContract: token },
            primaryType: 'TransferWithAuthorization',
            message: { from: `0x${'ab'.repeat(20)}`, to: sellerAddress, value: '10000' },
          },
          payment: { x402Version: 2, accepted: { scheme: 'exact', amount: '10000', payTo: sellerAddress } },
        },
      })
      expect(JSON.stringify(quote)).toContain('no refund')
    }))

  test('x402_quote refuses a challenge that asks more, pays someone else, or is no challenge', () =>
    withGateway(async (gateway) => {
      const { seller, call } = await setUp(gateway, ['discuss'])
      const asked = { seller, slug: 'weather' }
      gateway.resources.set(resource, sellerAsking('10001'))
      expect(await call('x402_quote', asked)).toMatchObject({
        ok: false,
        refusal: { reason: 'ChallengeMismatch', detail: 'amount' },
      })
      gateway.resources.set(resource, sellerAsking('10000', `0x${'66'.repeat(20)}`))
      expect(await call('x402_quote', asked)).toMatchObject({
        ok: false,
        refusal: { reason: 'ChallengeMismatch', detail: 'payTo' },
      })
      gateway.resources.set(resource, sellerAsking('10000', sellerAddress, 200))
      expect(await call('x402_quote', asked)).toMatchObject({ ok: false, refusal: { reason: 'NoChallenge' } })
      gateway.resources.delete(resource)
      expect(await call('x402_quote', asked)).toMatchObject({ ok: false, refusal: { reason: 'ResourceUnreachable' } })
    }))

  test('x402_quote refuses an escrow listing, an unknown one, and a payTo that is not the seller’s wallet', () =>
    withGateway(async (gateway) => {
      const { seller, call } = await setUp(gateway, ['discuss'])
      gateway.core.listings.set(`${seller}/logos`, {
        ...listingOf(seller),
        slug: 'logos',
        rail: 'escrow',
        payPerCall: null,
      })
      expect(await call('x402_quote', { seller, slug: 'logos' })).toMatchObject({
        ok: false,
        refusal: { reason: 'NotPayPerCall' },
      })
      expect(await call('x402_quote', { seller, slug: 'nothing' })).toMatchObject({
        ok: false,
        refusal: { reason: 'UnknownListing' },
      })
      const unlinked = { resource, payTo: sellerWallet, payToLinked: false, verifiedReceipts: 0 }
      gateway.core.listings.set(`${seller}/weather`, listingOf(seller, { payPerCall: unlinked }))
      expect(await call('x402_quote', { seller, slug: 'weather' })).toMatchObject({
        ok: false,
        refusal: { reason: 'PayToNotLinked' },
      })
    }))

  test('x402_receipt publishes the receipt signed by the agent under its grant, with the accept scope only', () =>
    withGateway(async (gateway) => {
      const transaction = `0x${'7a'.repeat(32)}`
      const discussing = await setUp(gateway, ['discuss'])
      expect(
        await discussing.call('x402_receipt', { seller: discussing.seller, slug: 'weather', transaction }),
      ).toMatchObject({
        ok: false,
        refusal: { reason: 'ScopeMissing' },
      })
      const { agent, grant, seller, call } = await setUp(gateway, ['accept'])
      const answered = await call('x402_receipt', { seller, slug: 'weather', transaction })
      expect(answered).toMatchObject({ ok: true, value: { payer: operatorWallet, signedBy: agent, grant: grant.id } })
      const [receipt] = await eventsOfKind(gateway.core, paymentReceipt)
      expect(receipt?.content).toEqual({
        listing: `30402:${seller}:weather`,
        version: 'f5'.repeat(32),
        resource,
        payer: operatorWallet,
        amount: '10000',
        asset: UsdcOnArcTestnet.id,
        transaction,
      })
      expect(receipt?.event.pubkey).toBe(agent)
      expect(receipt?.event.tags).toContainEqual([envelopeTag.grant, grant.id])
    }))
})

describe('the resources the gateway asks', () => {
  test.each([
    ['https://weather.example.com/now', true],
    ['https://weather.example.com', true],
    ['http://weather.example.com/now', false],
    ['https://weather.example.com:8443/now', false],
    ['https://user:pw@weather.example.com/now', false],
    ['https://localhost/now', false],
    ['https://core.localhost/now', false],
    ['https://127.0.0.1/now', false],
    ['https://[::1]/now', false],
    ['https://weather.example.com/now#x', false],
    ['not a url', false],
  ])('%s is asked: %s', (url, asked) => expect(isResourceUrl(url)).toBe(asked))
})
