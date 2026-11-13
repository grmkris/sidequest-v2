import { ChainRpc } from '@sidequest/settlement/ChainRpc'
import { Layer, Option } from 'effect'
import { ArcRpc } from './ArcRpc.ts'
import { D1RelayerIntents } from './D1RelayerIntents.ts'
import { Settlement } from './Settlement.ts'
import type { SettlementConfig } from './SettlementConfig.ts'

/** Settlement reads and relays through the Arc RPC client the Worker's configuration names. */
export const ChainRpcFromArc = Layer.effect(ChainRpc, ArcRpc)

/**
 * Settlement for `config`, its relayer's intents on D1, or none when settlement is not configured. Needs `ArcRpc` and
 * the database's `SqlClient`.
 */
export const settlementLive = (config: Option.Option<SettlementConfig>) =>
  Option.match(config, {
    onNone: () => Settlement.disabled,
    onSome: (configured) =>
      Settlement.layer(configured).pipe(Layer.provide(Layer.mergeAll(D1RelayerIntents, ChainRpcFromArc))),
  })
