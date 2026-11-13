import { AccountRef, NetworkRef, UnixSeconds } from '@sidequest/protocol'
import { Schema } from 'effect'
import type { KindSpec } from './KindSpec.ts'
import { sidequestKinds } from './Kinds.ts'

/**
 * An EVM account as CAIP-10, `eip155:<chain id>:0x<40 hex>`, in lowercase: relays match `#i` exactly, so one wallet
 * must have one spelling.
 */
export const EvmAccount = AccountRef.check(Schema.isPattern(/^eip155:[1-9][0-9]{0,15}:0x[0-9a-f]{40}$/u))
export type EvmAccount = typeof EvmAccount.Type

/** A wallet's signature as `0x` hex: 65 bytes from an EOA, any length from an ERC-1271 smart account. */
const WalletSignature = Schema.String.check(Schema.isPattern(/^0x(?:[0-9a-fA-F]{2}){1,8192}$/u))

/**
 * A Nostr key claims a wallet (kind 8210): the wallet's EIP-712 signature of `LinkNostrKey(pubkey, issuedAt)` (see
 * `walletLinkTypedData`) proves the wallet agreed. The `i` tag is the account so `#i` finds who claims it, and the
 * account's chain is the event's network. Verifying the wallet's signature is the indexer's job.
 */
export const WalletLinkContent = Schema.Struct({
  address: EvmAccount,
  issuedAt: UnixSeconds,
  walletSignature: WalletSignature,
})
export type WalletLinkContent = typeof WalletLinkContent.Type

/** The CAIP-2 chain of an EVM account: everything before its last colon. */
export const networkOfAccount = (account: EvmAccount): NetworkRef =>
  // `eip155:<chain id>` always matches the CAIP-2 pattern.
  NetworkRef.make(account.slice(0, account.lastIndexOf(':')))

export const walletLink: KindSpec<WalletLinkContent> = {
  kind: sidequestKinds.walletLink,
  content: WalletLinkContent,
  routing: (content) => [['i', content.address]],
  network: (content) => networkOfAccount(content.address),
}
