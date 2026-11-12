import { ConfirmSubmission } from '@sidequest/domain/Job/ConfirmSubmission.saga'
import { FundingSubmitted, SettleJob } from '@sidequest/domain/Job/SettleJob.saga'
import {
  type Agreement,
  Conflict,
  type EscrowStage,
  Forbidden,
  type JobId,
  SidequestApi,
  SignedInAccount,
  Unavailable,
} from '@sidequest/protocol'
import type { OperatorCall } from '@sidequest/settlement/OperatorCall'
import type { SettlementChain } from '@sidequest/settlement/SettlementChain'
import {
  approvalTypedData,
  deliveryTypedData,
  rejectionTypedData,
  toProtocolTypedData,
} from '@sidequest/settlement/TypedData'
import { digestWord } from '@sidequest/settlement/Words'
import { Effect, Option } from 'effect'
import { HttpApiBuilder } from 'effect/http-api'
import { type Hex, isHex } from 'viem'
import { Escrow, type EscrowService } from '../Settlement/Escrow.ts'
import { PeopleClients, signedIn } from './People.ts'
import { settlementParties } from './SettlementParties.ts'
import { settlementRefused } from './SettlementRefusals.ts'

// `WalletSignature` admits only hex, so the fallback never applies; an empty signature would only fail on chain.
const hexOf = (signature: string): Hex => (isHex(signature) ? signature : '0x')

/** The party has not handed over an artifact to sign for, or no agreement is recorded to read. */
const nothingToSign = (job: JobId) => new Conflict({ reason: 'NothingToSign', evidence: { job } })

/** The agreement's escrow payment, once the buyer asked to fund it. */
const paymentOf = (service: EscrowService, agreement: Agreement) =>
  Effect.flatMap(settlementRefused(service.expected(agreement)), (expected) =>
    Option.match(expected, {
      onNone: () => Effect.fail(new Unavailable()),
      onSome: ({ payment }) => Effect.succeed(payment),
    }),
  )

type TypedBuilder = (
  paymentHash: Hex,
  deliveryHash: Hex,
  chain: SettlementChain,
) => Parameters<typeof toProtocolTypedData>[0]

/** What the endpoints work with: the escrow (if configured), the model's parties, and the settlement sagas. */
const endpoints = Effect.gen(function* () {
  const configured = yield* Escrow
  const parties = yield* settlementParties
  const settlements = yield* SettleJob
  const confirmations = yield* ConfirmSubmission
  const asPerson = signedIn(yield* PeopleClients)
  const escrow = Option.match(configured, {
    onNone: () => Effect.fail(new Unavailable()),
    onSome: (service) => Effect.succeed(service),
  })

  /** Relays a party's signed call, then confirms the step from `from` on: the job follows what the chain did. */
  const relaySigned = Effect.fnUntraced(function* (
    agreement: Agreement,
    step: string,
    from: EscrowStage,
    call: (info: OperatorCall['info']) => OperatorCall,
  ) {
    const service = yield* escrow
    const payment = yield* paymentOf(service, agreement)
    const relayed = yield* settlementRefused(service.relay(`${step}:${payment.hash}`, call(payment.info)))
    yield* confirmations.start(`${agreement.job}:${step}`, { agreement, from })
    return { transactionHash: relayed.transactionHash }
  })

  /** The typed data a party signs over the payment and the delivery hash, in the stage it belongs to. */
  const typedFor = Effect.fnUntraced(function* (
    job: JobId,
    role: 'buyer' | 'worker',
    stage: 'Funded' | 'Delivered',
    build: TypedBuilder,
  ) {
    const state = yield* parties.jobIn(job, [stage])
    const { agreement } = state
    yield* parties.requireParty(yield* SignedInAccount, role === 'buyer' ? agreement.buyer : agreement.worker, role)
    if (state.artifactHash === null) return yield* nothingToSign(job)
    const service = yield* escrow
    const payment = yield* paymentOf(service, agreement)
    return toProtocolTypedData(build(payment.hash, digestWord(state.artifactHash), service.chain))
  })

  /** The agreement of a delivered job, when the signed-in buyer acts on it. */
  const asBuyerOfDelivered = Effect.fnUntraced(function* (job: JobId) {
    const { agreement } = yield* parties.jobIn(job, ['Delivered'])
    yield* parties.requireParty(yield* SignedInAccount, agreement.buyer, 'buyer')
    return agreement
  })

  return { configured, escrow, parties, settlements, asPerson, relaySigned, typedFor, asBuyerOfDelivered }
})

type Endpoints = Effect.Success<typeof endpoints>

/** The buyer asks what to sign to fund: the exact payment from their wallet to the worker's. */
const funding = (on: Endpoints, job: JobId, payer: string | undefined) =>
  Effect.gen(function* () {
    const { agreement } = yield* on.parties.jobIn(job, ['Awarded'])
    yield* on.parties.requireParty(yield* SignedInAccount, agreement.buyer, 'buyer')
    const network = agreement.terms.network
    const from = yield* on.parties.walletFor(agreement.buyer, network, payer)
    const to = yield* on.parties.walletFor(agreement.worker, network)
    const service = yield* on.escrow
    return yield* settlementRefused(service.begin(agreement, from, to))
  })

/** The buyer's signed authorization goes to the chain; the saga starts looking for the funding. */
const fund = (on: Endpoints, job: JobId, signature: string) =>
  Effect.gen(function* () {
    const { agreement } = yield* on.parties.jobIn(job, ['Awarded'])
    yield* on.parties.requireParty(yield* SignedInAccount, agreement.buyer, 'buyer')
    const service = yield* on.escrow
    const relayed = yield* settlementRefused(service.submit(agreement, hexOf(signature)))
    yield* on.settlements.get(job).signal(FundingSubmitted, undefined)
    return { transactionHash: relayed.transactionHash }
  })

/** The chain reader's view of the payment, for the buyer or the worker. */
const payment = (on: Endpoints, job: JobId) =>
  Effect.gen(function* () {
    const state = yield* on.parties.jobIn(job, ['Awarded', 'Funded', 'Delivered', 'Disputed', 'Settled'])
    const agreement = state.agreement
    if (agreement === null) return yield* nothingToSign(job)
    const account = yield* SignedInAccount
    if (account !== agreement.worker) yield* on.parties.requireParty(account, agreement.buyer, 'party')
    const service = yield* on.escrow
    return yield* settlementRefused(service.status(agreement))
  })

/** The worker's signed delivery of the artifact they handed over goes to the chain. */
const signDelivery = (on: Endpoints, job: JobId, signature: string) =>
  Effect.gen(function* () {
    const state = yield* on.parties.jobIn(job, ['Funded'])
    yield* on.parties.requireParty(yield* SignedInAccount, state.agreement.worker, 'worker')
    if (state.artifactHash === null) return yield* nothingToSign(job)
    const deliveryHash = digestWord(state.artifactHash)
    return yield* on.relaySigned(state.agreement, 'delivery', 'Funded', (info) => ({
      function: 'deliver',
      info,
      deliveryHash,
      signature: hexOf(signature),
    }))
  })

/** The buyer's signed approval goes to the chain, which pays the worker. */
const approve = (on: Endpoints, job: JobId, signature: string) =>
  Effect.flatMap(on.asBuyerOfDelivered(job), (agreement) =>
    on.relaySigned(agreement, 'approval', 'Delivered', (info) => ({
      function: 'approve',
      info,
      signature: hexOf(signature),
    })),
  )

/** The buyer's signed rejection goes to the chain first; then their reason is recorded, for the arbitrator. */
const reject = (on: Endpoints, job: JobId, signature: string, reason: string) =>
  Effect.gen(function* () {
    const agreement = yield* on.asBuyerOfDelivered(job)
    const relayed = yield* on.relaySigned(agreement, 'rejection', 'Delivered', (info) => ({
      function: 'reject',
      info,
      signature: hexOf(signature),
    }))
    yield* on.asPerson.send((people) => people.RejectDelivery({ target: job, reason }))
    return relayed
  })

/**
 * The interim arbitrator's ruling. In phase 1 only the configured arbitration operator account may issue one; the
 * server signs it with Sidequest's testnet arbitrator key and relays it.
 */
const rule = (on: Endpoints, job: JobId, workerShareBps: number) =>
  Effect.gen(function* () {
    const account = yield* SignedInAccount
    const operator = Option.flatMap(on.configured, (service) => service.arbitrationOperator)
    if (Option.getOrUndefined(operator) !== account)
      return yield* new Forbidden({ reason: 'NotPermitted', evidence: { account, required: 'arbitrationOperator' } })
    const { agreement } = yield* on.parties.jobIn(job, ['Disputed'])
    const service = yield* on.escrow
    const sign = yield* Option.match(service.signRuling, {
      onNone: () => Effect.fail(new Unavailable()),
      onSome: Effect.succeed,
    })
    const signature = yield* sign((yield* paymentOf(service, agreement)).hash, workerShareBps)
    return yield* on.relaySigned(agreement, 'ruling', 'Disputed', (info) => ({
      function: 'rule',
      info,
      workerShareBps,
      signature,
    }))
  })

/**
 * The `settlement` group. Each step is the signature of the party whose step it is; the server relays it with its
 * relayer key and starts a confirmation that records the step on the job once the chain reader verified it. Nothing
 * here records a money stage: the order is always sign, relay, read the chain, record.
 */
export const settlementHandlers = HttpApiBuilder.group(SidequestApi, 'settlement', (handlers) =>
  Effect.map(endpoints, (on) =>
    handlers
      .handle('funding', ({ params, query }) => funding(on, params.job, query.payer))
      .handle('fund', ({ params, payload }) => fund(on, params.job, payload.signature))
      .handle('payment', ({ params }) => payment(on, params.job))
      .handle('deliveryToSign', ({ params }) => on.typedFor(params.job, 'worker', 'Funded', deliveryTypedData))
      .handle('signDelivery', ({ params, payload }) => signDelivery(on, params.job, payload.signature))
      .handle('approvalToSign', ({ params }) => on.typedFor(params.job, 'buyer', 'Delivered', approvalTypedData))
      .handle('approve', ({ params, payload }) => approve(on, params.job, payload.signature))
      .handle('rejectionToSign', ({ params }) => on.typedFor(params.job, 'buyer', 'Delivered', rejectionTypedData))
      .handle('reject', ({ params, payload }) => reject(on, params.job, payload.signature, payload.reason))
      .handle('rule', ({ params, payload }) => rule(on, params.job, payload.workerShareBps)),
  ),
)
