import { Amount, AssetId, Bytes32, findAsset, NetworkRef } from '@sidequest/protocol'
import { Effect, Option, Schema } from 'effect'
import { EventId } from './Event.ts'
import type { KindSpec } from './KindSpec.ts'
import { sidequestKinds } from './Kinds.ts'
import { ListingAddress } from './ListingAddress.ts'
import { PublicKey } from './PublicKey.ts'
import { eventTag, personTag } from './RoutingTags.ts'
import { EvmAccount, networkOfAccount } from './WalletLink.ts'
import { X402ResourceUrl } from './ServiceListing.ts'

/**
 * A buyer's receipt for one paid call on the x402 rail (kind 8420, ADR-0006): which listing (its address, and the
 * version whose price and `payTo` it paid), the resource called, the wallet that paid, how much of which asset, and the
 * settlement transaction. A claim the buyer (or their agent, naming its grant) makes; the index labels it verified only
 * when the chain shows that transfer. It concerns money on the asset's network, named in `sq-net`.
 */
export const PaymentReceiptContent = Schema.Struct({
  listing: ListingAddress,
  version: EventId,
  resource: X402ResourceUrl,
  payer: EvmAccount,
  amount: Amount.check(Schema.makeFilter((amount: string) => amount !== '0', { expected: 'positiveAmount' })),
  asset: AssetId,
  transaction: Bytes32,
})
export type PaymentReceiptContent = typeof PaymentReceiptContent.Type

/** The seller's key: the middle part of the listing's address. */
export const sellerOf = (listing: ListingAddress): PublicKey =>
  // A listing address is `30402:<64 lowercase hex>:<slug>`, so its middle part is a public key.
  PublicKey.make(listing.split(':')[1] ?? '')

/** The asset's network: everything before its `/`. */
const assetNetwork = (asset: AssetId): NetworkRef =>
  // A CAIP-19 asset id starts with its CAIP-2 network.
  NetworkRef.make(asset.slice(0, asset.indexOf('/')))

/** A registered asset, paid from a wallet on its own network. */
const consistent = (content: PaymentReceiptContent) =>
  Effect.succeed(
    Option.isSome(findAsset(content.asset)) && networkOfAccount(content.payer) === assetNetwork(content.asset),
  )

export const paymentReceipt: KindSpec<PaymentReceiptContent> = {
  kind: sidequestKinds.paymentReceipt,
  content: PaymentReceiptContent,
  routing: (content) => [['a', content.listing], eventTag(content.version), personTag(sellerOf(content.listing))],
  network: (content) => assetNetwork(content.asset),
  check: consistent,
}
