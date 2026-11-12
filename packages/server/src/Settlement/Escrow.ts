import type { Agreement, EscrowStatus } from '@sidequest/protocol'
import { Arbitrator } from '@sidequest/settlement/Arbitrator'
import { readEscrow } from '@sidequest/settlement/ChainReader'
import { ChainRpc } from '@sidequest/settlement/ChainRpc'
import { EscrowAdapter, expectedOf } from '@sidequest/settlement/EscrowAdapter'
import { confirmedHead } from '@sidequest/settlement/LogScan'
import { PaymentAdapter, paymentRequestId } from '@sidequest/settlement/PaymentAdapter'
import type { ReaderCursors } from '@sidequest/settlement/ReaderCursors'
import { Relayer } from '@sidequest/settlement/Relayer'
import { Context, Effect, Layer, Option } from 'effect'
import type { Address, Hex } from 'viem'
import type { EscrowConfig } from './EscrowConfig.ts'

const make = (config: EscrowConfig) =>
  Effect.gen(function* () {
    const rpc = yield* ChainRpc
    const adapter = yield* PaymentAdapter
    const relayer = yield* Relayer
    const reading = yield* Effect.context<ChainRpc | ReaderCursors>()
    const arbitrator = yield* Effect.serviceOption(Arbitrator)
    const { chain } = config

    /** The payment the agreement's request stands for, once the buyer asked to fund. */
    const expected = Effect.fn('Sidequest.Escrow.expected')(function* (agreement: Agreement) {
      const record = yield* adapter.lookup(paymentRequestId(agreement))
      if (Option.isNone(record) || record.value.state === 'cancelled') return Option.none()
      return Option.some(yield* expectedOf(record.value, agreement, chain))
    })

    /** What the chain reader verified for the agreement's payment; unfunded until the buyer asked to fund. */
    const status = Effect.fn('Sidequest.Escrow.status')(function* (agreement: Agreement) {
      const payment = yield* expected(agreement)
      if (Option.isSome(payment)) return yield* readEscrow(payment.value).pipe(Effect.provide(reading))
      const { timestamp } = yield* confirmedHead(rpc, chain)
      const unfunded: EscrowStatus = {
        paymentHash: null,
        chainTime: timestamp,
        stage: 'Unfunded',
        funding: null,
        delivery: null,
        rejection: null,
        settlement: null,
        problems: [],
      }
      return unfunded
    })

    return {
      chain,
      arbitrationOperator: config.arbitrationOperator,
      begin: (agreement: Agreement, payer: Address, receiver: Address) =>
        adapter.begin({ id: paymentRequestId(agreement), agreement, payer, receiver }),
      submit: (agreement: Agreement, authorization: Hex) =>
        adapter.submit(paymentRequestId(agreement), agreement, authorization),
      expected,
      status,
      relay: relayer.relay,
      signRuling: Option.map(arbitrator, (service) => service.signRuling),
    }
  })

/** The escrow as the server uses it: the payment adapter, the chain reader, the relayer and the interim arbitrator. */
export type EscrowService = Effect.Success<ReturnType<typeof make>>

/**
 * Settlement on the configured chain, or none: until `SidequestOperator` is deployed and configured, the endpoints
 * that need the chain answer `Unavailable` and the saga's looks find nothing.
 */
export class Escrow extends Context.Service<Escrow, Option.Option<EscrowService>>()('Sidequest/Escrow') {
  static readonly disabled = Layer.succeed(Escrow, Option.none())

  /** Settlement with `config`; it needs `ChainRpc` and the settlement stores. */
  static readonly layer = (config: EscrowConfig) => {
    const relayer = Relayer.layer(config.relayerKey, config.chain)
    const arbitrator = Option.match(config.arbitratorKey, {
      onNone: () => Layer.empty,
      onSome: (key) => Arbitrator.layer(key, config.chain),
    })
    return Layer.effect(Escrow, Effect.map(make(config), Option.some)).pipe(
      Layer.provide(Layer.mergeAll(EscrowAdapter(config.chain).pipe(Layer.provideMerge(relayer)), arbitrator)),
    )
  }
}
