import {
  Amount,
  type IndexFunding,
  type IndexPaymentStatus,
  type IndexSettlementReason,
  IndexSettlementRefused,
  NotIndexed,
  Unavailable,
} from '@sidequest/protocol'
import type { OperatorCall } from '@sidequest/settlement/OperatorCall'

type DeliverDelegatedCall = Extract<OperatorCall, { readonly function: 'deliverDelegated' }>
import { type Payment, termsPaymentOf } from '@sidequest/settlement/Payment'
import type { RelayError } from '@sidequest/settlement/Relayer'
import {
  approvalTypedData,
  deliveryDelegateTypedData,
  deliveryTypedData,
  fundingTypedData,
  rejectionTypedData,
  toProtocolTypedData,
} from '@sidequest/settlement/TypedData'
import { addressOn } from '@sidequest/settlement/Words'
import { Effect, Match, Option, Predicate } from 'effect'
import { type Address, getAddress, type Hex, isHex } from 'viem'
import { ChainFacts } from '../Index/ChainFacts.ts'
import { EventStore } from '../Index/EventStore.ts'
import { nowSeconds } from '../Index/Ingest.ts'
import { moneyOf, paymentOfFunding } from './FundedPayment.ts'
import { fundingRefusal, refusalDetail } from './FundingRules.ts'
import { type NativeChain, nativeChain, relayedReads } from './NativeChain.ts'
import { requestOf, standingReads } from './Standing.ts'

// A chain fact's `Bytes32` admits only `0x` and 64 hex digits, so the fallback never applies.
const wordOf = (value: string): Hex => (isHex(value) ? value : '0x')

/** A refusal with its reason and, where the chain said something, what it said. */
export const refused = (reason: IndexSettlementReason, detail?: string) =>
  new IndexSettlementRefused(detail === undefined ? { reason } : { reason, detail })

/** The relayer's failures as the API's: the chain refusing the call, or the chain or a store out of reach. */
const relayRefused = (failure: RelayError) =>
  Match.valueTags(failure, {
    CallReverted: ({ reason }) => refused('ChainRefused', reason),
    IntentConflict: () => refused('ChainRefused', 'IntentConflict'),
    ChainUnavailable: () => new Unavailable(),
    SettlementStoreError: () => new Unavailable(),
  })

/** The protocol's view of a payment the buyer's wallet signs for. */
const fundingOf = (job: string, proposal: string, payment: Payment, on: NativeChain): IndexFunding => {
  const { info, params } = payment
  return {
    job,
    proposal,
    paymentHash: payment.hash,
    network: on.chain.asset.network,
    asset: on.chain.asset.id,
    amount: Amount.make(String(info.maxAmount)),
    paymentInfo: { ...info, maxAmount: Amount.make(String(info.maxAmount)), salt: String(info.salt) },
    jobParams: params,
    escrow: on.chain.escrow,
    typedData: toProtocolTypedData(fundingTypedData(payment, on.chain)),
  }
}

type Wiring = Effect.Success<ReturnType<typeof wiring>>

const wiring = (chain: Option.Option<NativeChain>) =>
  Effect.gen(function* () {
    return {
      on: Option.match(chain, {
        onNone: () => Effect.fail(new Unavailable()),
        onSome: (configured) => Effect.succeed(configured),
      }),
      standing: yield* standingReads,
      events: yield* EventStore,
      facts: yield* ChainFacts,
      relayed: yield* relayedReads,
    }
  })

/**
 * The payment that would fund `proposal` of `job` from `payer`, once every funding rule holds (`FundingRules.ts`):
 * built from the proposal's signed terms and `payTo` exactly as `termsPaymentOf` builds it.
 */
const fundable = Effect.fnUntraced(function* (w: Wiring, job: string, proposal: string, payer: string) {
  const on = yield* w.on
  const network = on.chain.asset.network
  const standing = yield* w.standing(job, proposal, `${network}:${payer.toLowerCase()}`)
  const offer = Option.getOrUndefined(standing.proposal)
  const receiver = offer === undefined ? undefined : addressOn(network, offer.content.payTo)
  const reason = fundingRefusal(standing, receiver === undefined ? '' : `${network}:${receiver}`, yield* nowSeconds)
  if (reason !== undefined) return yield* refused(reason, refusalDetail(standing, reason))
  // The rules found the proposal and its receiver on this network; this only narrows their types.
  if (offer === undefined || receiver === undefined) return yield* refused('ProposalNotIndexed')
  const payment = yield* termsPaymentOf(
    { job, termsDigest: offer.content.termsDigest, terms: offer.content.terms },
    { payer: getAddress(payer), receiver },
    on.chain,
  ).pipe(Effect.mapError(({ reason: field }) => refused('Unpayable', field)))
  return { on, payment }
})

/** The job's funded payment, rebuilt from its `JobFunded` log, and that payment's later facts. */
const funded = Effect.fnUntraced(function* (w: Wiring, job: string) {
  const on = yield* w.on
  if (Option.isNone(yield* requestOf(w.events, job))) return yield* refused('RequestNotIndexed')
  const money = moneyOf(yield* w.facts.forJob(job))
  if (money.funding === undefined) return yield* refused('NotFunded')
  const payment = paymentOfFunding(money.funding, on.chain)
  if (Option.isNone(payment)) return yield* refused('ChainRefused', 'PaymentNotRebuildable')
  return { ...money, on, payment: payment.value }
})

/** Relays a call for the job's payment under the step's intent id (one per payment and step). */
const relayFor = (on: NativeChain, step: string, payment: Payment, call: OperatorCall) =>
  on.relay(`${step}:${payment.hash}`, call).pipe(
    Effect.map(({ transactionHash }) => ({ transactionHash })),
    Effect.mapError(relayRefused),
  )

/** The recorded delivery's hash, which approvals and rejections name. */
const deliveredHash = Effect.fnUntraced(function* (w: Wiring, job: string) {
  const state = yield* funded(w, job)
  if (state.delivery === undefined) return yield* refused('NotDelivered')
  return { ...state, deliveryHash: wordOf(state.delivery.deliveryHash) }
})

const verdict = (w: Wiring, job: string, kind: 'approve' | 'reject', signature: Hex) =>
  Effect.flatMap(deliveredHash(w, job), ({ on, payment }) =>
    relayFor(on, kind === 'approve' ? 'approval' : 'rejection', payment, {
      function: kind,
      info: payment.info,
      signature,
    }),
  )

const stageOf = (money: ReturnType<typeof moneyOf>): Pick<IndexPaymentStatus, 'stage' | 'outcome'> => {
  if (money.funding === undefined) return { stage: 'Unfunded', outcome: null }
  if (money.ending !== undefined)
    return {
      stage: 'Settled',
      outcome: Predicate.isTagged(money.ending, 'Reclaimed') ? 'Reclaimed' : money.ending.outcome,
    }
  if (money.rejection !== undefined) return { stage: 'Disputed', outcome: null }
  return { stage: money.delivery === undefined ? 'Funded' : 'Delivered', outcome: null }
}

/** Where the job's payment stands: the chain's facts, the chain's time and what the relayer did for it. */
const status = Effect.fnUntraced(function* (w: Wiring, job: string) {
  const on = yield* w.on
  if (Option.isNone(yield* requestOf(w.events, job))) return yield* new NotIndexed()
  const money = moneyOf(yield* w.facts.forJob(job))
  const chainTime = yield* on.chainTime.pipe(Effect.mapError(() => new Unavailable()))
  const paymentHash = money.funding?.paymentHash ?? null
  const answer: IndexPaymentStatus = {
    escrow: on.chain.escrow,
    paymentHash,
    chainTime,
    ...stageOf(money),
    relayed: paymentHash === null ? [] : yield* w.relayed(paymentHash),
  }
  return answer
})

/**
 * Nostr-native escrow: what to sign and the relay of each signed step, for a job whose id is its request event's id.
 * Every money call's authority is the wallet signature it carries, which the contract checks; the server only refuses
 * what it should not pay gas for, simulates, and relays. Needs `Escrow`, `ArcRpc`, the index's `EventStore` and
 * `ChainFacts`, and the database.
 */
export const nativeEscrowWith = (chain: Option.Option<NativeChain>) =>
  Effect.map(wiring(chain), (w) => ({
    quote: (job: string, proposal: string, payer: string) =>
      Effect.map(fundable(w, job, proposal, payer), ({ on, payment }) => fundingOf(job, proposal, payment, on)),
    fund: (job: string, proposal: string, payer: string, signature: Hex) =>
      Effect.flatMap(fundable(w, job, proposal, payer), ({ on, payment }) =>
        relayFor(on, 'fund', payment, {
          function: 'fund',
          info: payment.info,
          params: payment.params,
          authorization: signature,
        }),
      ),
    deliveryToSign: (job: string, deliveryHash: Hex) =>
      Effect.map(funded(w, job), ({ on, payment }) =>
        toProtocolTypedData(deliveryTypedData(payment.hash, deliveryHash, on.chain)),
      ),
    deliver: (job: string, deliveryHash: Hex, signature: Hex) =>
      Effect.flatMap(funded(w, job), ({ on, payment }) =>
        relayFor(on, 'delivery', payment, { function: 'deliver', info: payment.info, deliveryHash, signature }),
      ),
    /** What the worker's wallet signs to let `delegate` record the job's delivery until `expiry`. */
    delegationToSign: (job: string, delegate: Address, expiry: number) =>
      Effect.map(funded(w, job), ({ on, payment }) =>
        toProtocolTypedData(deliveryDelegateTypedData(payment.hash, delegate, expiry, on.chain)),
      ),
    /**
     * Relays a delivery the delegate signed under the worker's delegation. Its own intent per payment, beside the
     * worker's direct `delivery`: whichever the chain mines first is the delivery, and the other then reverts.
     */
    deliverDelegated: (job: string, delivery: Omit<DeliverDelegatedCall, 'function' | 'info'>) =>
      Effect.flatMap(funded(w, job), ({ on, payment }) =>
        relayFor(on, 'delegated-delivery', payment, { function: 'deliverDelegated', info: payment.info, ...delivery }),
      ),
    verdictToSign: (job: string, kind: 'approve' | 'reject') =>
      Effect.map(deliveredHash(w, job), ({ on, payment, deliveryHash }) =>
        toProtocolTypedData(
          (kind === 'approve' ? approvalTypedData : rejectionTypedData)(payment.hash, deliveryHash, on.chain),
        ),
      ),
    verdict: (job: string, kind: 'approve' | 'reject', signature: Hex) => verdict(w, job, kind, signature),
    /** Signs the ruling with the interim arbitrator's key and relays it; the caller checked who asked for it. */
    rule: (job: string, workerShareBps: number) =>
      Effect.gen(function* () {
        const { on, payment } = yield* funded(w, job)
        const sign = yield* Option.match(on.signRuling, {
          onNone: () => Effect.fail(new Unavailable()),
          onSome: Effect.succeed,
        })
        const signature = yield* sign(payment.hash, workerShareBps)
        return yield* relayFor(on, 'ruling', payment, {
          function: 'rule',
          info: payment.info,
          workerShareBps,
          signature,
        })
      }),
    status: (job: string) => status(w, job),
  }))

/** Nostr-native escrow on the configured chain (see `nativeEscrowWith`). */
export const nativeEscrow = Effect.flatMap(nativeChain, nativeEscrowWith)

export type NativeEscrow = Effect.Success<ReturnType<typeof nativeEscrowWith>>
