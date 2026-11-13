import { Layer, Option } from 'effect'
import { createPublicClient, custom, type PublicClient } from 'viem'
import { EscrowSettings, type ArbitrationSettings } from '../src/Escrow/EscrowSettings.ts'
import { type IndexConfig, idleIndex, IndexSettings } from '../src/Index/IndexConfig.ts'
import { IndexLive } from '../src/Index/IndexLive.ts'
import { ArcRpc } from '../src/Settlement/ArcRpc.ts'
import type { SettlementConfig } from '../src/Settlement/SettlementConfig.ts'
import { settlementLive } from '../src/Settlement/SettlementLive.ts'
import { localSql } from './LocalSql.ts'

/** A chain that answers nothing: every call fails, as an unreachable RPC endpoint does. */
export const noChain = (): PublicClient =>
  createPublicClient({
    transport: custom({
      request: ({ method }: { readonly method: string }) => Promise.reject(new Error(`No chain answers ${method}`)),
    }),
  })

/** How a test world settles: no escrow (the default), or one on a test chain, and who may ask for rulings. */
export interface Settling {
  readonly escrow: Option.Option<SettlementConfig>
  readonly arbitration?: ArbitrationSettings
}

/**
 * The API's services on a fresh local D1: the index (idle unless `index` names relays), settlement as `settling`
 * says, and `rpc` as the chain. `sqlite` reads the database directly.
 */
export const serverWorld = (
  rpc: PublicClient = noChain(),
  settling: Settling = { escrow: Option.none() },
  index: IndexConfig = idleIndex,
) => {
  const { sqlite, layer: sql } = localSql()
  const layer = IndexLive.pipe(
    Layer.provideMerge(Layer.succeed(IndexSettings, index)),
    Layer.provideMerge(settlementLive(settling.escrow)),
    Layer.provideMerge(Layer.succeed(ArcRpc, rpc)),
    Layer.provideMerge(
      settling.arbitration === undefined ? Layer.empty : Layer.succeed(EscrowSettings, settling.arbitration),
    ),
    Layer.provideMerge(sql),
  )
  return { sqlite, layer }
}
