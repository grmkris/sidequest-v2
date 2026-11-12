import { Context, Effect, Option, Schema } from 'effect'
import type { SettlementStoreError } from './ReaderCursors.ts'

/**
 * A transaction the relayer means to send, recorded before it is sent: its id (one per job and action), the
 * relayer's address, the nonce it holds, the call, and once signed, the raw transaction and its hash.
 */
export const RelayIntent = Schema.Struct({
  id: Schema.String,
  signer: Schema.String,
  nonce: Schema.Int,
  to: Schema.String,
  data: Schema.String,
  signedTransaction: Schema.NullOr(Schema.String),
  transactionHash: Schema.NullOr(Schema.String),
})
export type RelayIntent = typeof RelayIntent.Type

/** What reserving an intent needs: its id, call and the lowest nonce the chain would accept from the signer. */
export interface Reservation {
  readonly id: string
  readonly signer: string
  readonly to: string
  readonly data: string
  readonly minimumNonce: number
}

/**
 * The relayer's intents. `reserve` is atomic: it returns the intent already recorded under the id, or records a new
 * one with the next nonce the signer has not used (at least `minimumNonce`), so two relays never share a nonce.
 * `sign` records the raw transaction before it is sent.
 */
export class RelayerIntents extends Context.Service<
  RelayerIntents,
  {
    readonly reserve: (reservation: Reservation) => Effect.Effect<RelayIntent, SettlementStoreError>
    readonly sign: (
      id: string,
      signedTransaction: string,
      transactionHash: string,
    ) => Effect.Effect<void, SettlementStoreError>
    readonly find: (id: string) => Effect.Effect<Option.Option<RelayIntent>, SettlementStoreError>
  }
>()('Sidequest/Settlement/RelayerIntents') {}

/** Relayer intents in memory. */
export const memoryRelayerIntents = (): RelayerIntents['Service'] => {
  const intents = new Map<string, RelayIntent>()
  const nextNonce = (signer: string) =>
    [...intents.values()]
      .filter((intent) => intent.signer === signer)
      .reduce((next, { nonce }) => Math.max(next, nonce + 1), 0)
  return {
    reserve: (reservation) =>
      Effect.sync(() => {
        const existing = intents.get(reservation.id)
        if (existing !== undefined) return existing
        const { minimumNonce, ...call } = reservation
        const intent: RelayIntent = {
          ...call,
          nonce: Math.max(minimumNonce, nextNonce(reservation.signer)),
          signedTransaction: null,
          transactionHash: null,
        }
        intents.set(reservation.id, intent)
        return intent
      }),
    sign: (id, signedTransaction, transactionHash) =>
      Effect.sync(() => {
        const intent = intents.get(id)
        if (intent !== undefined) intents.set(id, { ...intent, signedTransaction, transactionHash })
      }),
    find: (id) => Effect.sync(() => Option.fromNullishOr(intents.get(id))),
  }
}
