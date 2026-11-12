import { Context, Effect, Option, Schema } from 'effect'
import { SettlementStoreError } from './ReaderCursors.ts'

/**
 * One signed transaction of an intent, recorded before it is broadcast: the intent's call, or a release (a transfer of
 * nothing from the relayer to itself, which only uses up the nonce). `sequence` orders an intent's transactions at one
 * nonce; fees are decimal strings in wei; `signedAt` is Unix milliseconds; `reason` is why it replaced the one before
 * (null for the first); `refused` is what the node said when it refused the transaction outright, if it did.
 */
export const RelayTransaction = Schema.Struct({
  hash: Schema.String,
  sequence: Schema.Int,
  kind: Schema.Literals(['call', 'release']),
  raw: Schema.String,
  maxFeePerGas: Schema.String,
  maxPriorityFeePerGas: Schema.String,
  signedAt: Schema.Number,
  reason: Schema.NullOr(Schema.String),
  refused: Schema.NullOr(Schema.String),
})
export type RelayTransaction = typeof RelayTransaction.Type

/**
 * Where an intent stands. `open` until its nonce is used on chain: then `mined` when one of its call transactions used
 * it, `released` when its release (or a transaction it never signed) did. `outcome` names the transaction that used
 * the nonce, `reason` why the intent was released or why its mined call failed.
 */
export const IntentState = Schema.Literals(['open', 'mined', 'released'])
export type IntentState = typeof IntentState.Type

/**
 * A transaction the relayer means to send, recorded before it is sent: its id (one per job and action), the
 * relayer's address, the nonce it holds, the call, where it stands, and the transactions signed for it at that nonce,
 * oldest first. Every one of them carries the same nonce, so the chain mines at most one.
 */
export const IntentRecord = Schema.Struct({
  id: Schema.String,
  signer: Schema.String,
  nonce: Schema.Int,
  to: Schema.String,
  data: Schema.String,
  state: IntentState,
  outcome: Schema.NullOr(Schema.String),
  reason: Schema.NullOr(Schema.String),
})
export const RelayIntent = Schema.Struct({ ...IntentRecord.fields, transactions: Schema.Array(RelayTransaction) })
export type RelayIntent = typeof RelayIntent.Type

/** What reserving an intent needs: its id, call and the lowest nonce the chain would accept from the signer. */
export interface Reservation {
  readonly id: string
  readonly signer: string
  readonly to: string
  readonly data: string
  readonly minimumNonce: number
}

/** How an open intent ended: the transaction that used its nonce (none when it is not ours) and why. */
export interface Closing {
  readonly state: 'mined' | 'released'
  readonly outcome: string | null
  readonly reason: string | null
}

/**
 * The relayer's intents, the only record of which nonce stands for which call. Every write is atomic on its own, so
 * relays that race (two requests, a retry and a sweep) agree without a transaction:
 *
 * - `reserve` returns the intent already recorded under the id, or records a new one with the next nonce the signer
 *   has not used (at least `minimumNonce`), so two intents never share a nonce.
 * - `record` appends a signed transaction at the intent's nonce only if the intent is still open at that nonce and
 *   holds exactly `sequence` transactions there: of two relays that read the same intent, one records and the other
 *   finds its transaction and broadcasts that instead. It answers the intent as it stands afterwards.
 * - `refused` notes that the node refused a transaction.
 * - `close` ends an open intent at `nonce` once the chain used that nonce; closing again changes nothing.
 * - `reopen` gives a released intent a fresh nonce, the same way `reserve` picks one: the old nonce is used, so its
 *   call can never be mined there, and the call may be tried again.
 * - `open` lists a signer's open intents, lowest nonce first.
 */
export class RelayerIntents extends Context.Service<
  RelayerIntents,
  {
    readonly reserve: (reservation: Reservation) => Effect.Effect<RelayIntent, SettlementStoreError>
    readonly record: (
      id: string,
      nonce: number,
      transaction: RelayTransaction,
    ) => Effect.Effect<RelayIntent, SettlementStoreError>
    readonly refused: (hash: string, reason: string) => Effect.Effect<void, SettlementStoreError>
    readonly close: (id: string, nonce: number, closing: Closing) => Effect.Effect<void, SettlementStoreError>
    readonly reopen: (id: string, minimumNonce: number) => Effect.Effect<RelayIntent, SettlementStoreError>
    readonly find: (id: string) => Effect.Effect<Option.Option<RelayIntent>, SettlementStoreError>
    readonly open: (signer: string) => Effect.Effect<ReadonlyArray<RelayIntent>, SettlementStoreError>
  }
>()('Sidequest/Settlement/RelayerIntents') {}

interface Stored {
  readonly intent: Omit<RelayIntent, 'transactions'>
  /** Every transaction ever signed for the intent, at any nonce it held. */
  readonly transactions: ReadonlyArray<RelayTransaction & { readonly nonce: number }>
}

type Memory = Map<string, Stored>

/** The signer's next nonce: an intent only ever moves above every other, so the highest it holds is the highest used. */
const nextNonce = (memory: Memory, signer: string, minimumNonce: number) =>
  [...memory.values()]
    .filter(({ intent }) => intent.signer === signer)
    .reduce((next, { intent }) => Math.max(next, intent.nonce + 1), minimumNonce)

/** The intent as the port answers it: with its transactions at the nonce it holds now. */
const view = ({ intent, transactions }: Stored): RelayIntent => ({
  ...intent,
  transactions: transactions
    .filter(({ nonce }) => nonce === intent.nonce)
    .map((transaction) => Schema.decodeSync(RelayTransaction)(transaction)),
})

const found = (memory: Memory, id: string) => Option.map(Option.fromNullishOr(memory.get(id)), view)

const recorded = (memory: Memory, id: string) =>
  Effect.flatMap(
    Effect.sync(() => found(memory, id)),
    Option.match({
      onNone: () => Effect.fail(new SettlementStoreError({ store: 'relayer_intents' })),
      onSome: Effect.succeed,
    }),
  )

const reserveIn = (memory: Memory, { minimumNonce, ...call }: Reservation) => {
  const existing = memory.get(call.id)
  if (existing !== undefined) return view(existing)
  const nonce = nextNonce(memory, call.signer, minimumNonce)
  const stored: Stored = { intent: { ...call, nonce, state: 'open', outcome: null, reason: null }, transactions: [] }
  memory.set(call.id, stored)
  return view(stored)
}

const recordIn = (memory: Memory, id: string, nonce: number, transaction: RelayTransaction) => {
  const stored = memory.get(id)
  if (stored === undefined) return
  const taken = [...memory.values()].some(({ transactions }) =>
    transactions.some(({ hash }) => hash === transaction.hash),
  )
  const fits =
    stored.intent.state === 'open' &&
    stored.intent.nonce === nonce &&
    view(stored).transactions.length === transaction.sequence &&
    !taken
  if (fits) memory.set(id, { ...stored, transactions: [...stored.transactions, { ...transaction, nonce }] })
}

const refuseIn = (memory: Memory, hash: string, reason: string) => {
  for (const [id, stored] of memory) {
    const transactions = stored.transactions.map((transaction) =>
      transaction.hash === hash ? { ...transaction, refused: reason } : transaction,
    )
    memory.set(id, { ...stored, transactions })
  }
}

const closeIn = (memory: Memory, id: string, nonce: number, closing: Closing) => {
  const stored = memory.get(id)
  if (stored === undefined || stored.intent.state !== 'open' || stored.intent.nonce !== nonce) return
  memory.set(id, { ...stored, intent: { ...stored.intent, ...closing } })
}

const reopenIn = (memory: Memory, id: string, minimumNonce: number) => {
  const stored = memory.get(id)
  if (stored === undefined || stored.intent.state !== 'released') return
  const nonce = nextNonce(memory, stored.intent.signer, minimumNonce)
  memory.set(id, { ...stored, intent: { ...stored.intent, nonce, state: 'open', outcome: null, reason: null } })
}

/** Relayer intents in memory: the model the D1 store is checked against. */
export const memoryRelayerIntents = (): RelayerIntents['Service'] => {
  const memory: Memory = new Map()
  return {
    reserve: (reservation) => Effect.sync(() => reserveIn(memory, reservation)),
    record: (id, nonce, transaction) =>
      Effect.andThen(
        Effect.sync(() => recordIn(memory, id, nonce, transaction)),
        recorded(memory, id),
      ),
    refused: (hash, reason) => Effect.sync(() => refuseIn(memory, hash, reason)),
    close: (id, nonce, closing) => Effect.sync(() => closeIn(memory, id, nonce, closing)),
    reopen: (id, minimumNonce) =>
      Effect.andThen(
        Effect.sync(() => reopenIn(memory, id, minimumNonce)),
        recorded(memory, id),
      ),
    find: (id) => Effect.sync(() => found(memory, id)),
    open: (signer) =>
      Effect.sync(() =>
        [...memory.values()]
          .filter(({ intent }) => intent.signer === signer && intent.state === 'open')
          .map(view)
          .toSorted((a, b) => a.nonce - b.nonce),
      ),
  }
}
