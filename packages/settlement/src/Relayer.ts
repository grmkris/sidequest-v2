import { Context, Effect, Layer, Option, Redacted, Schema } from 'effect'
import {
  type Address,
  BaseError,
  ContractFunctionRevertedError,
  type Hex,
  isHex,
  keccak256,
  type PublicClient,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { ChainRpc, ChainUnavailable, rpcCall } from './ChainRpc.ts'
import { type OperatorCall, operatorCalldata } from './OperatorCall.ts'
import type { SettlementStoreError } from './ReaderCursors.ts'
import { type RelayIntent, RelayerIntents } from './RelayerIntents.ts'
import type { SettlementChain } from './SettlementChain.ts'

/** The id names another call already: one id is one action on one job, and its call never changes. */
export class IntentConflict extends Schema.TaggedError<IntentConflict>()('IntentConflict', { id: Schema.String }) {}

/** The chain refuses the call as it stands (the simulation reverted): it would fail on chain too. */
export class CallReverted extends Schema.TaggedError<CallReverted>()('CallReverted', {
  function: Schema.String,
  reason: Schema.String,
}) {}

/** A relayed transaction: the intent it belongs to and its hash. */
export interface Relayed {
  readonly id: string
  readonly transactionHash: Hex
}

export type RelayError = IntentConflict | CallReverted | ChainUnavailable | SettlementStoreError

/** Gas for a transaction whose simulation can no longer run (its nonce must still be used): the most any call needs. */
const fallbackGas = 1_000_000n

const revertReason = (cause: unknown) => {
  if (!(cause instanceof BaseError)) return undefined
  const reverted = cause.walk((error) => error instanceof ContractFunctionRevertedError)
  if (reverted instanceof ContractFunctionRevertedError) return reverted.data?.errorName ?? reverted.shortMessage
  return /revert/i.test(cause.message) ? cause.shortMessage : undefined
}

const simulate = (rpc: PublicClient, from: Address, call: OperatorCall, to: Address, data: Hex) =>
  Effect.tryPromise({
    try: () => rpc.estimateGas({ account: from, to, data }),
    catch: (cause) => {
      const reason = revertReason(cause)
      return reason === undefined
        ? new ChainUnavailable({ operation: 'eth_estimateGas' })
        : new CallReverted({ function: call.function, reason })
    },
  })

/**
 * Sends `SidequestOperator` calls from Sidequest's relayer key, a Worker secret. Sidequest never signs for a person:
 * the calls carry the party's own signature, or are deadline functions anyone may call. Safe on retries: an intent is
 * recorded, with its nonce, before anything is sent, and its signed transaction before it is broadcast; a retry finds
 * the intent and looks the transaction up before sending the same bytes again. The same id with a different call is
 * refused. A call that reverts in simulation is refused before it takes a nonce.
 */
export class Relayer extends Context.Service<
  Relayer,
  {
    readonly address: Address
    readonly relay: (id: string, call: OperatorCall) => Effect.Effect<Relayed, RelayError>
  }
>()('Sidequest/Settlement/Relayer') {
  static readonly layer = (key: Redacted.Redacted<Hex>, chain: SettlementChain) =>
    Layer.effect(
      Relayer,
      Effect.gen(function* () {
        const rpc = yield* ChainRpc
        const intents = yield* RelayerIntents
        const account = privateKeyToAccount(Redacted.value(key))

        const signFor = Effect.fnUntraced(function* (intent: RelayIntent, gas: bigint) {
          const fees = yield* rpcCall('eth_feeHistory', () => rpc.estimateFeesPerGas())
          const signed = yield* rpcCall('sign', () =>
            account.signTransaction({
              type: 'eip1559',
              chainId: chain.chainId,
              nonce: intent.nonce,
              to: chain.operator,
              data: isHex(intent.data) ? intent.data : '0x',
              gas,
              maxFeePerGas: fees.maxFeePerGas,
              maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
            }),
          )
          const hash = keccak256(signed)
          yield* intents.sign(intent.id, signed, hash)
          return { signed, hash }
        })

        /** Broadcast unless the chain has the transaction already, mined or pending. */
        const broadcast = Effect.fnUntraced(function* (signed: Hex, hash: Hex) {
          const mined = yield* rpcCall('eth_getTransactionReceipt', () => rpc.getTransactionReceipt({ hash })).pipe(
            Effect.option,
          )
          if (Option.isSome(mined)) return
          const pending = yield* rpcCall('eth_getTransactionByHash', () => rpc.getTransaction({ hash })).pipe(
            Effect.option,
          )
          if (Option.isSome(pending)) return
          yield* rpcCall('eth_sendRawTransaction', () => rpc.sendRawTransaction({ serializedTransaction: signed }))
        })

        const resume = Effect.fnUntraced(function* (intent: RelayIntent, gas: Option.Option<bigint>) {
          const stored =
            intent.signedTransaction !== null &&
            isHex(intent.signedTransaction) &&
            intent.transactionHash !== null &&
            isHex(intent.transactionHash)
              ? { signed: intent.signedTransaction, hash: intent.transactionHash }
              : yield* signFor(
                  intent,
                  Option.getOrElse(gas, () => fallbackGas),
                )
          yield* broadcast(stored.signed, stored.hash)
          return { id: intent.id, transactionHash: stored.hash }
        })

        const relay = Effect.fn('Sidequest.Settlement.relay')(function* (id: string, call: OperatorCall) {
          yield* Effect.annotateCurrentSpan({ 'settlement.intent': id, 'settlement.function': call.function })
          const data = operatorCalldata(call)
          const existing = yield* intents.find(id)
          if (Option.isSome(existing)) {
            if (existing.value.data !== data) return yield* new IntentConflict({ id })
            return yield* resume(existing.value, Option.none())
          }
          const gas = yield* simulate(rpc, account.address, call, chain.operator, data)
          const minimumNonce = yield* rpcCall('eth_getTransactionCount', () =>
            rpc.getTransactionCount({ address: account.address, blockTag: 'pending' }),
          )
          const reservation = { id, signer: account.address, to: chain.operator, data, minimumNonce }
          const intent = yield* intents.reserve(reservation)
          if (intent.data !== data) return yield* new IntentConflict({ id })
          return yield* resume(intent, Option.some((gas * 6n) / 5n))
        })

        return Relayer.of({ address: account.address, relay })
      }),
    )
}
