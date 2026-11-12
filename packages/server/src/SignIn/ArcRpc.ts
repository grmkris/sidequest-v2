import { Context, Layer } from 'effect'
import { createPublicClient, http, type PublicClient } from 'viem'

/** Arc testnet's public JSON-RPC endpoint (see the asset registry, `packages/protocol/src/AssetRegistry.ts`). */
export const arcTestnetRpcUrl = 'https://rpc.testnet.arc.io'

/** The RPC endpoint the Worker's configuration names in `SIDEQUEST_ARC_RPC_URL`, or Arc testnet's public one. */
export const arcRpcUrlFrom = (environment: Readonly<Record<string, unknown>>): string => {
  const url = environment.SIDEQUEST_ARC_RPC_URL
  return typeof url === 'string' && url.length > 0 ? url : arcTestnetRpcUrl
}

/**
 * A JSON-RPC client for Arc testnet. Sign-in asks it only to check a contract account's ERC-1271 signature; tests
 * give it a fake transport.
 */
export class ArcRpc extends Context.Service<ArcRpc, PublicClient>()('Sidequest/ArcRpc') {
  static readonly layer = (url: string) =>
    Layer.sync(ArcRpc, () => createPublicClient({ transport: http(url, { retryCount: 1, timeout: 10_000 }) }))
}
