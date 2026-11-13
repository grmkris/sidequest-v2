import {
  exactAuthorization,
  exactPaymentPayload,
  exactTypedData,
  IndexListingDetail,
  ListingReceipt,
  matchChallenge,
  x402Header,
  x402Headers,
  X402PaymentPayload,
  X402PaymentRequired,
  X402Settlement,
} from '@sidequest/protocol'
import { Effect, Layer, Option, Result, Schema } from 'effect'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { seller } from '../../examples/x402-seller/seller.ts'
import { signTyped } from '../../packages/server/rehearsal/Surfaces.ts'
import { ChainLogPoller } from '../../packages/server/src/Index/ChainLogPoller.ts'
import { ChainRpcFromArc } from '../../packages/server/src/Settlement/SettlementLive.ts'
import { type LocalChain, onChainOnly, skipOnChain, startChain } from '../../packages/server/test/Anvil.ts'
import { type Api, withApi } from '../../packages/server/test/HttpWorld.ts'
import { accountOf, alice, bob, carol, linked, walletOne, walletTwo } from '../../packages/server/test/IndexWorld.ts'
import { payPerCallListing, receiptBy, resource } from '../../packages/server/test/PayPerCallWorld.ts'
import { serverWorld } from '../../packages/server/test/World.ts'
import { localFacilitator, transferAuthorizationTokenCode } from '../../packages/server/test/LocalFacilitator.ts'

// The x402 rail end to end on a local chain (ADR-0006): a seller's pay-per-call listing is published to the index, the
// buyer asks the seller's resource for its price (a 402 with the challenge), checks it against the listing, signs the
// ERC-3009 authorization with their wallet, and calls again with the payment; the seller (the reference seller in
// examples/x402-seller) verifies and settles it through a facilitator (a local one, in process) that submits the
// transfer to Anvil, and answers with the work and the settlement. The buyer publishes a receipt naming the transaction;
// once the chain log poller records it, the index shows it verified, and receipts with a wrong payer, amount or payTo
// unverified. Sidequest's servers are never in the payment path: the index only reads what the chain says.

const price = 10_000n
const tokenAddress = '0x3600000000000000000000000000000000000000'
const facilitatorUrl = 'https://facilitator.test'

const post = (api: Api, path: string, body: unknown) =>
  api.fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

const publish = async (api: Api, event: unknown) => expect((await post(api, '/api/events', event)).status).toBe(200)

const read = async <A>(schema: Schema.Decoder<A>, response: Response) => {
  const body: unknown = await response.json()
  if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(body)}`)
  return Schema.decodeUnknownSync(schema)(body)
}

const header = <S extends Schema.Codec<unknown, unknown>>(schema: S, value: string | null) => {
  if (value === null) throw new Error('The header is missing')
  return Schema.decodeUnknownSync(x402Header(schema))(value)
}

describe.skipIf(skipOnChain)('the x402 rail on a local chain', () => {
  onChainOnly('the x402 rail on a local chain')
  let chain: LocalChain
  beforeAll(async () => {
    chain = await startChain()
    const response = await fetch(chain.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'anvil_setCode',
        params: [tokenAddress, transferAuthorizationTokenCode()],
      }),
    })
    if (!response.ok) throw new Error('anvil_setCode failed')
  }, 60_000)
  afterAll(() => chain?.stop())

  /** One pass of the chain log poller, which also asks the chain about receipts' transactions. */
  const poll = (api: Api) =>
    api.run(
      Effect.flatMap(ChainLogPoller, (poller) => poller.run).pipe(
        Effect.provide(ChainLogPoller.layer(chain.chain, Option.none()).pipe(Layer.provide(ChainRpcFromArc))),
      ),
    )

  test(
    'a listing, a challenge, a signed payment, the call served, a receipt, and the index labels it from the chain',
    () =>
      withApi(
        async (api) => {
          const at = Math.floor(Date.now() / 1000)
          const sellerWallet = accountOf(walletTwo)
          const listing = payPerCallListing(bob, 'weather', at, sellerWallet, String(price))
          await publish(api, await linked(bob, walletTwo, at))
          await publish(api, await linked(alice, walletOne, at))
          await publish(api, listing)
          await chain.mint(walletOne.address, 5n * price)
          const facilitator = localFacilitator(chain.client, chain.url)
          const call = seller({
            resource,
            network: chain.chain.asset.network,
            asset: tokenAddress,
            token: chain.chain.tokenDomain,
            amount: String(price),
            payTo: walletTwo.address,
            facilitator: facilitatorUrl,
            maxTimeoutSeconds: 300,
            fetch: facilitator.fetch,
          })

          // The index shows the listing on the x402 rail, its payTo the seller's verified wallet.
          const shown = await read(IndexListingDetail, await api.fetch(`/api/index/listings/${listing.pubkey}/weather`))
          expect(shown).toMatchObject({
            rail: 'x402',
            payPerCall: { resource, payTo: sellerWallet, payToLinked: true, verifiedReceipts: 0 },
          })
          if (shown.payPerCall === null || shown.price === null) throw new Error('Not a pay-per-call listing')

          // The unpaid call: 402, and a challenge that asks exactly what the listing says.
          const unpaid = await call(new Request(resource))
          expect(unpaid.status).toBe(402)
          const challenge = header(X402PaymentRequired, unpaid.headers.get(x402Headers.required))
          const terms = {
            resource,
            payTo: shown.payPerCall.payTo,
            amount: shown.price.amount,
            asset: shown.price.asset,
          }
          const offer = Result.getOrThrow(matchChallenge(terms, challenge))

          // The buyer's wallet signs the authorization; the paid call is served and settled on chain.
          const now = Number((await chain.client.getBlock()).timestamp)
          const authorization = exactAuthorization(offer, walletOne.address, {
            nonce: `0x${'5a'.repeat(32)}`,
            validAfter: now - 60,
            validBefore: now + offer.requirements.maxTimeoutSeconds,
          })
          const signature = await signTyped(walletOne, exactTypedData(offer, authorization))
          const payment = exactPaymentPayload(challenge, offer, authorization, signature)
          const paid = await call(
            new Request(resource, {
              headers: { [x402Headers.signature]: Schema.encodeSync(x402Header(X402PaymentPayload))(payment) },
            }),
          )
          expect(paid.status).toBe(200)
          expect(await paid.json()).toMatchObject({ forecast: 'sunny' })
          const settlement = header(X402Settlement, paid.headers.get(x402Headers.response))
          expect(settlement).toMatchObject({ success: true, network: chain.chain.asset.network })
          expect([await chain.balanceOf(walletOne.address), await chain.balanceOf(walletTwo.address)]).toEqual([
            4n * price,
            price,
          ])

          // The same payment again is refused: the authorization's nonce is spent.
          const replayed = await call(
            new Request(resource, {
              headers: { [x402Headers.signature]: Schema.encodeSync(x402Header(X402PaymentPayload))(payment) },
            }),
          )
          expect(replayed.status).toBe(402)
          expect(facilitator.settled).toHaveLength(1)

          // Receipts: the true one, and three that claim what the chain does not show.
          const transaction = settlement.transaction
          const otherPayTo = payPerCallListing(
            bob,
            'weather-other',
            at,
            `${chain.chain.asset.network}:0x${'99'.repeat(20)}`,
            String(price),
          )
          await publish(api, otherPayTo)
          const receipts = {
            paid: receiptBy(
              alice,
              { version: listing, payer: accountOf(walletOne), amount: String(price), transaction },
              at + 1,
            ),
            wrongPayer: receiptBy(
              carol,
              { version: listing, payer: accountOf(walletTwo), amount: String(price), transaction },
              at + 1,
            ),
            wrongAmount: receiptBy(
              alice,
              { version: listing, payer: accountOf(walletOne), amount: String(price + 1n), transaction },
              at + 2,
            ),
            wrongPayTo: receiptBy(
              alice,
              { version: otherPayTo, payer: accountOf(walletOne), amount: String(price), transaction },
              at + 3,
            ),
          }
          for (const receipt of Object.values(receipts)) await publish(api, receipt)

          // Before the poller asks the chain, nothing is verified; after, only the true receipt is.
          const labels = async (slug: string) =>
            (
              await read(
                Schema.Struct({ items: Schema.Array(ListingReceipt) }),
                await api.fetch(`/api/index/listings/${listing.pubkey}/${slug}/receipts`),
              )
            ).items.map(({ event, verified }) => [event, verified])
          expect((await labels('weather')).every(([, verified]) => !verified)).toBe(true)
          await poll(api)
          expect(await labels('weather')).toEqual(
            expect.arrayContaining([
              [receipts.paid.id, true],
              [receipts.wrongPayer.id, false],
              [receipts.wrongAmount.id, false],
            ]),
          )
          expect(await labels('weather-other')).toEqual([[receipts.wrongPayTo.id, false]])
          const counted = await read(
            IndexListingDetail,
            await api.fetch(`/api/index/listings/${listing.pubkey}/weather`),
          )
          expect(counted.payPerCall?.verifiedReceipts).toBe(1)
        },
        serverWorld(chain.client, { escrow: Option.some(chain.config) }).layer,
      ),
    120_000,
  )
})
