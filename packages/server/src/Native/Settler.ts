import { ChainFunded } from '@sidequest/fold'
import { sidequestKinds } from '@sidequest/nostr/vocabulary'
import type { RelayedCall, Unavailable } from '@sidequest/protocol'
import type { ChainUnavailable } from '@sidequest/settlement/ChainRpc'
import type { DeadlineFunction } from '@sidequest/settlement/OperatorCall'
import { Context, Effect, Layer, Option, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'
import { stored } from '@sidequest/serving/Stored'
import { paymentOfFunding } from './FundedPayment.ts'
import { keptTerms } from './KeptTerms.ts'
import { type NativeChain, nativeChain, relayedReads } from './NativeChain.ts'

/**
 * How much one run does: at most `duePerRun` payments whose deadline call is due, oldest funding first; and at most
 * `attempts` intents per payment and call, so a call the relayer had to release (the node kept refusing it, or it
 * reverted on chain) is tried again on a fresh nonce no more than that, and the escrow's own reclaim after expiry is the
 * payer's fallback.
 */
export const settlerLimits = { duePerRun: 10, attempts: 3 } as const

const DeadlineCall = Schema.Literals(['refundUndelivered', 'settleAfterReview', 'settleUnruled'])
const Due = Schema.Struct({ fact: Schema.fromJsonString(ChainFunded), call: DeadlineCall })

/** What the settler did about one due payment, for its log and its tests. */
export type SettlerOutcome = {
  readonly paymentHash: string
  readonly call: DeadlineFunction
} & (
  | { readonly result: 'sent'; readonly intent: string; readonly transactionHash: string }
  | { readonly result: 'pending'; readonly intent: string }
  | { readonly result: 'mined' | 'gaveUp' | 'unrebuildable' }
  | { readonly result: 'reverted' | 'failed'; readonly reason: string }
)

/**
 * The Funded payments of Nostr-native jobs (a request event with the job's id is indexed) that have not ended (no
 * `Settled` or `Reclaimed` fact on the payment) and whose deadline call is due at `now`, the chain's time: the
 * payment's first rejection's `arbitrationEndsAt` (`settleUnruled`), else its first delivery's `reviewEndsAt`
 * (`settleAfterReview`), else the funding's `deliveryDeadline` (`refundUndelivered`). One statement, bounded.
 */
const dueQuery = (sql: SqlClient.SqlClient) =>
  SqlSchema.findAll({
    Request: Schema.Struct({ now: Schema.Int, limit: Schema.Int }),
    Result: Due,
    execute: ({ now, limit }) => sql`
      WITH unsettled AS (
        SELECT f.block, f.log_index, f.fact AS funded,
          (SELECT d.fact FROM chain_facts AS d WHERE d.payment_hash = f.payment_hash AND d.kind = 'Delivered'
            ORDER BY d.block, d.log_index LIMIT 1) AS delivered,
          (SELECT r.fact FROM chain_facts AS r WHERE r.payment_hash = f.payment_hash AND r.kind = 'Rejected'
            ORDER BY r.block, r.log_index LIMIT 1) AS rejected
        FROM chain_facts AS f
        WHERE f.kind = 'Funded'
          AND EXISTS (SELECT 1 FROM events AS q WHERE q.id = f.job AND q.kind = ${sidequestKinds.request})
          AND NOT EXISTS (SELECT 1 FROM chain_facts AS e
            WHERE e.payment_hash = f.payment_hash AND e.kind IN ('Settled', 'Reclaimed'))
      ), timed AS (
        SELECT block, log_index, funded,
          CASE WHEN rejected IS NOT NULL THEN 'settleUnruled'
            WHEN delivered IS NOT NULL THEN 'settleAfterReview' ELSE 'refundUndelivered' END AS call,
          CASE WHEN rejected IS NOT NULL THEN json_extract(rejected, '$.arbitrationEndsAt')
            WHEN delivered IS NOT NULL THEN json_extract(delivered, '$.reviewEndsAt')
            ELSE json_extract(funded, '$.deliveryDeadline') END AS due_at
        FROM unsettled
      )
      SELECT funded AS fact, call FROM timed WHERE due_at <= ${now}
      ORDER BY block, log_index LIMIT ${limit}`,
  })

type Relayed = (paymentHash: string) => Effect.Effect<ReadonlyArray<RelayedCall>, Unavailable>

/**
 * One due payment. Another call already in flight for the payment (an approval, a delivery, a funding not yet closed)
 * means nothing is sent now; the settler's own open intent is resumed, which never takes a second nonce; a mined one
 * means the chain has it and the log poller will record it. Otherwise it relays a new attempt, which the relayer
 * simulates before it reserves a nonce: a call that would revert is not sent, and is looked at again next run.
 */
const settleOne = Effect.fnUntraced(function* (
  on: NativeChain,
  relayed: Relayed,
  funding: ChainFunded,
  call: DeadlineFunction,
): Effect.fn.Return<SettlerOutcome, Unavailable> {
  const at = { paymentHash: funding.paymentHash, call }
  const payment = paymentOfFunding(funding, on.chain)
  if (Option.isNone(payment)) return { ...at, result: 'unrebuildable' }
  const prefix = `${call}:${payment.value.hash}:native:`
  const intents = yield* relayed(payment.value.hash)
  const mine = intents.filter(({ intent }) => intent.startsWith(prefix))
  const other = intents.find(({ intent, state }) => state === 'open' && !intent.startsWith(prefix))
  if (other !== undefined) return { ...at, result: 'pending', intent: other.intent }
  const open = mine.find(({ state }) => state === 'open')
  if (mine.some(({ state, reason }) => state === 'mined' && reason === null)) return { ...at, result: 'mined' }
  if (open === undefined && mine.length >= settlerLimits.attempts) return { ...at, result: 'gaveUp' }
  const intent = open?.intent ?? `${prefix}${mine.length}`
  return yield* on.relay(intent, { function: call, info: payment.value.info }).pipe(
    Effect.map((sent): SettlerOutcome => ({ ...at, result: 'sent', intent, transactionHash: sent.transactionHash })),
    Effect.catchTags({
      CallReverted: ({ reason }) => Effect.succeed<SettlerOutcome>({ ...at, result: 'reverted', reason }),
      IntentConflict: () => Effect.succeed<SettlerOutcome>({ ...at, result: 'failed', reason: 'IntentConflict' }),
      ChainUnavailable: () => Effect.succeed<SettlerOutcome>({ ...at, result: 'failed', reason: 'ChainUnavailable' }),
      SettlementStoreError: () =>
        Effect.succeed<SettlerOutcome>({ ...at, result: 'failed', reason: 'SettlementStoreError' }),
    }),
  )
})

const logged = (outcome: SettlerOutcome) =>
  outcome.result === 'reverted' || outcome.result === 'failed' || outcome.result === 'gaveUp'
    ? Effect.logWarning('Sidequest.Native.settlerSkipped').pipe(Effect.annotateLogs({ alert: 'settler', ...outcome }))
    : Effect.logInfo('Sidequest.Native.settler').pipe(Effect.annotateLogs({ ...outcome }))

/**
 * The settler with `chain` (none: a stage without settlement, where it does nothing). Needs the database.
 */
export const makeSettler = (chain: Option.Option<NativeChain>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const due = dueQuery(sql)
    const relayed = yield* relayedReads
    const terms = yield* keptTerms
    const run = Effect.gen(function* () {
      if (Option.isNone(chain)) return []
      const on = chain.value
      yield* terms.keep
      yield* on.repair.pipe(Effect.catch((failure) => Effect.logWarning('Sidequest.Native.repairFailed', failure)))
      const now = yield* on.chainTime
      const payments = yield* stored(due({ now, limit: settlerLimits.duePerRun }))
      return yield* Effect.forEach(payments, ({ fact, call }) => Effect.tap(settleOne(on, relayed, fact, call), logged))
    }).pipe(Effect.withSpan('Sidequest.Native.settle'))
    return { run }
  })

/**
 * Settlement of Nostr-native jobs without a session or a job aggregate: a stateless reconciler that a Cron Trigger
 * runs after the chain log poller. From `chain_facts` it finds every payment of a job whose request event is indexed
 * that has not ended, compares the chain's time (the newest confirmed block's, never the server clock) with the
 * on-chain deadlines, and relays the permissionless call that is due: `refundUndelivered`, `settleAfterReview` or
 * `settleUnruled`. It never acts on a payment whose job has no indexed request: those are phase 1's, whose sagas act.
 * Each run first marks the funded jobs' terms as kept (`KeptTerms.ts`) and repairs the relayer's stuck intents. It is
 * idempotent: what it sends is an intent per payment, call and attempt, which the relayer never sends twice.
 */
export class Settler extends Context.Service<
  Settler,
  { readonly run: Effect.Effect<ReadonlyArray<SettlerOutcome>, ChainUnavailable | Unavailable> }
>()('Sidequest/Native/Settler') {
  /** On the configured escrow; needs `Escrow`, `ArcRpc` and the database's `SqlClient`. */
  static readonly layer = Layer.effect(Settler, Effect.flatMap(nativeChain, makeSettler))
}
