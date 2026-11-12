import { Context, Effect, Layer, Redacted } from 'effect'
import type { Address, Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { SettlementChain } from './SettlementChain.ts'
import { rulingTypedData } from './TypedData.ts'

/**
 * Phase 1's interim arbitrator on testnet: a Sidequest-held key that signs a `Ruling` for a disputed job. It signs
 * only rulings, in the operator's domain, so the signature can do nothing but settle that one dispute. Staked
 * arbitrators replace it in phase 3.
 */
export class Arbitrator extends Context.Service<
  Arbitrator,
  {
    readonly address: Address
    readonly signRuling: (paymentHash: Hex, workerShareBps: number) => Effect.Effect<Hex>
  }
>()('Sidequest/Settlement/Arbitrator') {
  static readonly layer = (key: Redacted.Redacted<Hex>, chain: SettlementChain) =>
    Layer.sync(Arbitrator, () => {
      const account = privateKeyToAccount(Redacted.value(key))
      return Arbitrator.of({
        address: account.address,
        signRuling: Effect.fn('Sidequest.Settlement.signRuling')((paymentHash: Hex, workerShareBps: number) =>
          // A local key signs without I/O; viem's promise only fails on malformed typed data, which this builds.
          Effect.promise(() => account.signTypedData(rulingTypedData(paymentHash, workerShareBps, chain))),
        ),
      })
    })
}
