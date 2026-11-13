import type { EventId, NostrEvent, SecretKey } from '@sidequest/nostr'
import {
  buildSidequestEvent,
  listingAddressOf,
  ListingSlug,
  paymentReceipt,
  PaymentReceiptContent,
  ServiceListing,
  serviceListingTemplate,
} from '@sidequest/nostr/vocabulary'
import { UsdcOnArcTestnet } from '@sidequest/protocol'
import { Effect, Schema } from 'effect'
import { signed } from './IndexWorld.ts'

// Events of the x402 rail for the index's tests: a seller's pay-per-call listing and a buyer's receipt for one call.

export const resource = 'https://weather.example.com/now'

/** `key`'s pay-per-call listing under `slug`, paying `payTo` (a lowercase CAIP-10 account) `amount` of USDC. */
export const payPerCallListing = (
  key: SecretKey,
  slug: string,
  createdAt: number,
  payTo: string,
  amount = '10000',
  url = resource,
) =>
  signed(
    serviceListingTemplate(
      Schema.decodeUnknownSync(ServiceListing)({
        slug,
        title: `Weather ${slug}`,
        summary: 'The weather now, as JSON.',
        description: 'One call, one forecast.',
        topics: ['weather'],
        price: { amount, asset: UsdcOnArcTestnet.id },
        status: 'active',
        publishedAt: createdAt,
        x402: { resource: url, payTo },
      }),
      createdAt,
    ),
    key,
  )

/** What a receipt claims: the listing version paid, the paying wallet, the amount and the transaction. */
export interface Claim {
  readonly version: NostrEvent
  readonly payer: string
  readonly amount: string
  readonly transaction: string
}

/** `key`'s receipt for `claim`, signed at `createdAt`, naming `grant` if an agent's key signs it. */
export const receiptBy = (key: SecretKey, claim: Claim, createdAt: number, grant?: EventId) => {
  const slug = ListingSlug.make(claim.version.tags.find((tag) => tag[0] === 'd')?.[1] ?? '')
  const content = Schema.decodeUnknownSync(PaymentReceiptContent)({
    listing: listingAddressOf(claim.version.pubkey, slug),
    version: claim.version.id,
    resource,
    payer: claim.payer,
    amount: claim.amount,
    asset: UsdcOnArcTestnet.id,
    transaction: claim.transaction,
  })
  return signed(
    Effect.runSync(
      buildSidequestEvent(paymentReceipt, content, { createdAt, ...(grant === undefined ? {} : { grant }) }),
    ),
    key,
  )
}
