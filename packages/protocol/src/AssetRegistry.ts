import { Array, type Option, Schema } from 'effect'
import { type AssetId, AssetRef } from './AssetRef.ts'

/**
 * USDC's ERC-20 interface on Arc testnet (CAIP-2 `eip155:5042002`), 6 decimals.
 * Chain id 5042002: https://docs.arc.io/arc/references/connect-to-arc.md (Testnet tab).
 * Address and decimals: https://docs.arc.io/arc/references/contract-addresses.md (Testnet tab).
 * Checked on 2026-11-12 against https://rpc.testnet.arc.io: eth_chainId 0x4cef52, decimals() 6,
 * symbol() "USDC".
 */
export const UsdcOnArcTestnet = Schema.decodeSync(AssetRef)({
  id: 'eip155:5042002/erc20:0x3600000000000000000000000000000000000000',
  network: 'eip155:5042002',
  decimals: 6,
  symbol: 'USDC',
})

/** Sidequest settles in USDC on Arc testnet only, for now (ADR-0002). */
const registered: ReadonlyArray<AssetRef> = [UsdcOnArcTestnet]

export const findAsset = (id: AssetId): Option.Option<AssetRef> =>
  Array.findFirst(registered, (asset) => asset.id === id)
