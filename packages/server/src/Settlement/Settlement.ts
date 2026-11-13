import { Arbitrator } from '@sidequest/settlement/Arbitrator'
import type { ChainUnavailable } from '@sidequest/settlement/ChainRpc'
import type { OperatorCall } from '@sidequest/settlement/OperatorCall'
import type { SettlementStoreError } from '@sidequest/settlement/RelayerIntents'
import { type RelayError, type Relayed, Relayer } from '@sidequest/settlement/Relayer'
import type { SettlementChain } from '@sidequest/settlement/SettlementChain'
import { Context, Effect, Layer, Option } from 'effect'
import type { Hex } from 'viem'
import type { SettlementConfig } from './SettlementConfig.ts'

/**
 * Settlement on the configured chain: the chain (with the deployed operator, the treasury and the interim arbitrator),
 * the relayer (one key, one nonce sequence, one store of intents, for every call the server sends) and, where its key
 * is configured, the interim arbitrator's signature on a ruling.
 */
export interface SettlementService {
  readonly chain: SettlementChain
  readonly relay: (id: string, call: OperatorCall) => Effect.Effect<Relayed, RelayError>
  /** Repairs every stuck intent and closes every mined one, as each relay does first. */
  readonly repair: Effect.Effect<void, SettlementStoreError | ChainUnavailable>
  readonly signRuling: Option.Option<(paymentHash: Hex, workerShareBps: number) => Effect.Effect<Hex>>
}

/**
 * Settlement on the configured chain, or none: until `SidequestOperator` is deployed and configured, the escrow
 * endpoints answer `Unavailable` and the settler and the chain log poller do nothing.
 */
export class Settlement extends Context.Service<Settlement, Option.Option<SettlementService>>()(
  'Sidequest/Settlement',
) {
  static readonly disabled = Layer.succeed(Settlement, Option.none())

  /** Settlement with `config`; it needs `ChainRpc` and the relayer's store of intents. */
  static readonly layer = (config: SettlementConfig) => {
    const arbitrator = Option.match(config.arbitratorKey, {
      onNone: () => Layer.empty,
      onSome: (key) => Arbitrator.layer(key, config.chain),
    })
    return Layer.effect(
      Settlement,
      Effect.gen(function* () {
        const relayer = yield* Relayer
        const signer = yield* Effect.serviceOption(Arbitrator)
        return Option.some<SettlementService>({
          chain: config.chain,
          relay: relayer.relay,
          repair: relayer.repair,
          signRuling: Option.map(signer, (service) => service.signRuling),
        })
      }),
    ).pipe(Layer.provide(Layer.mergeAll(Relayer.layer(config.relayerKey, config.chain), arbitrator)))
  }
}
