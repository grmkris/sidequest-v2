import { ChainRpc } from '@sidequest/settlement/ChainRpc'
import { Layer, Option } from 'effect'
import { ArcRpc } from '../SignIn/ArcRpc.ts'
import { D1SettlementStores } from './D1SettlementStores.ts'
import { Escrow } from './Escrow.ts'
import type { EscrowConfig } from './EscrowConfig.ts'

/** Settlement reads and relays through the same Arc RPC client sign-in uses. */
export const ChainRpcFromArc = Layer.effect(ChainRpc, ArcRpc)

/**
 * The escrow for `config`, with its stores on D1, or none when settlement is not configured. Needs `ArcRpc` and the
 * database's `SqlClient`.
 */
export const escrowLive = (config: Option.Option<EscrowConfig>) =>
  Option.match(config, {
    onNone: () => Escrow.disabled,
    onSome: (configured) =>
      Escrow.layer(configured).pipe(Layer.provide(Layer.mergeAll(D1SettlementStores, ChainRpcFromArc))),
  })
