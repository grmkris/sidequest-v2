import { UsdcOnArcTestnet } from '@sidequest/protocol'

// x18n-ignore-file: the chain's parameters as a wallet's `wallet_addEthereumChain` takes them, not text the site shows.

/** Arc testnet's chain id, from the asset registry's CAIP-2 network (`eip155:5042002`). */
export const arcChainId = Number(UsdcOnArcTestnet.network.slice('eip155:'.length))

/** The same id as a wallet speaks it: `0x4cef52`. */
export const arcChainHex = `0x${arcChainId.toString(16)}`

/** What a wallet needs to add Arc testnet. The registry names no RPC endpoint, so this is Arc's public one, the one the
 * API Worker reads by default (https://docs.arc.io/arc/references/connect-to-arc.md, Testnet tab). Arc's native coin is
 * USDC with 18 decimals; the ERC-20 at `0x3600…0000` is its 6-decimal view. */
export const arcChainParameters = {
  chainId: arcChainHex,
  chainName: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: ['https://rpc.testnet.arc.io'],
}
