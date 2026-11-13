import type { JobView } from '@sidequest/fold'
import type { NostrEvent } from '@sidequest/nostr'
import {
  FundedTerms,
  IndexFunding,
  IndexPaymentStatus,
  Relayed,
  Terms,
  TypedData,
  UsdcOnArcTestnet,
} from '@sidequest/protocol'
import type { PaymentInfo } from '@sidequest/settlement/Payment'
import { Predicate, Schema } from 'effect'
import { getAddress, isHex } from 'viem'
import { balances, passTime, reclaimFromEscrow, settled, type Wallets } from './Cases.ts'
import type { RehearsalChain } from './Chain.ts'
import { type CaseResult, type Evidence, step } from './Evidence.ts'
import { anyone, foldedJob, type NostrPerson, sign } from './Nostr.ts'
import type { RpcProxy } from './RpcProxy.ts'
import { bodyOf, eventually, signTyped } from './Surfaces.ts'

// The four hires of the gate, Nostr-native (ROADMAP slice 12): two Nostr keys with their linked wallets hire through
// signed events published to `POST /api/events` and the sessionless escrow endpoints, with no sign-in, no session
// cookie and no MCP. The job's stage is the index's fold of its events and the chain's logs, asserted at every step.

export interface EventsWorld extends Wallets {
  readonly url: string
  readonly chain: RehearsalChain
  readonly proxy: RpcProxy
  readonly buyer: NostrPerson
  readonly worker: NostrPerson
  /** Holds the stage's arbitration key, the only key whose NIP-98 authorization asks for a ruling. */
  readonly arbitration: NostrPerson
  readonly evidence: Evidence
}

const hour = 3600
const deliveryHash = '0x9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'
const fee = (captured: bigint) => (captured * 500n) / 10_000n

/** A job of the rehearsal: its request, the proposal the buyer accepted and that proposal's terms. */
interface Deal {
  readonly request: NostrEvent
  readonly proposal: NostrEvent
  readonly terms: Terms
}

const folded = (world: EventsWorld, deal: Deal, label: string, stage: JobView['stage'], seconds?: number) =>
  foldedJob(world.url, deal.request.id, (view) => view.stage === stage, seconds).then((view) => {
    step(world.evidence, { case: label, step: `the index's fold says ${stage}`, detail: { job: deal.request.id } })
    return view
  })

/** The buyer posts a request, the worker proposes, the buyer accepts: three signed events; the fold says accepted. */
const agreed = async (world: EventsWorld, label: string, deadlineIn: number): Promise<Deal> => {
  const api = anyone(world.url)
  const now = Math.max(await world.chain.now(), Math.floor(Date.now() / 1000))
  const request = await sign.request(world.buyer, `Gate rehearsal through events: ${label}`)
  await api.publish(request)
  const terms = Schema.decodeSync(Terms)({
    title: `Gate rehearsal through events: ${label}`,
    deliverables: ['A logo as SVG'],
    amount: String(world.chain.amount),
    asset: UsdcOnArcTestnet.id,
    network: UsdcOnArcTestnet.network,
    deliveryDeadline: now + deadlineIn,
    reviewWindowSeconds: hour,
    disputeWindowSeconds: hour,
    arbitrationWindowSeconds: 12 * hour,
    rail: 'escrow',
  })
  const proposal = await sign.proposal(world.worker, request, terms)
  await api.publish(proposal)
  await api.publish(await sign.accept(world.buyer, request, proposal, terms, world.worker.pubkey))
  step(world.evidence, {
    case: label,
    step: 'buyer published a request, worker a proposal, buyer an accept (POST /api/events)',
    detail: { job: request.id, proposal: proposal.id },
  })
  await folded(world, { request, proposal, terms }, label, 'accepted')
  return { request, proposal, terms }
}

/** The buyer's wallet signs the authorization the server quotes and the server relays `fund`; the fold says funded. */
const funded = async (world: EventsWorld, label: string, deal: Deal) => {
  const api = anyone(world.url)
  const path = `/api/index/jobs/${deal.request.id}/proposals/${deal.proposal.id}/funding`
  const quote = bodyOf(IndexFunding, await api.get(`${path}?payer=${world.buyer.wallet.address}`), 'quote')
  const shown: ReadonlyArray<readonly [string, string, string]> = [
    ['payer', quote.paymentInfo.payer, world.buyer.wallet.address],
    ['receiver', quote.paymentInfo.receiver, world.worker.wallet.address],
    ['operator', quote.paymentInfo.operator, world.chain.operator],
    ['feeReceiver', quote.paymentInfo.feeReceiver, world.chain.treasury],
    ['amount', quote.amount, String(world.chain.amount)],
    ['jobId', quote.jobParams.jobId, `0x${deal.request.id}`],
  ]
  for (const [field, actual, expected] of shown)
    if (actual.toLowerCase() !== expected.toLowerCase()) throw new Error(`The quote's ${field} is ${actual}`)
  const signature = await signTyped(world.buyer.wallet, quote.typedData)
  const relayed = bodyOf(Relayed, await api.post(path, { payer: world.buyer.wallet.address, signature }), 'funding')
  step(world.evidence, {
    case: label,
    step: 'buyer’s wallet signed the authorization; the relayer funded the escrow (no session)',
    transactionHash: relayed.transactionHash,
    detail: { paymentHash: quote.paymentHash, authorizationExpiry: quote.paymentInfo.authorizationExpiry },
  })
  const view = await folded(world, deal, label, 'funded')
  const funding = view.funding
  if (
    funding?.proposal !== deal.proposal.id ||
    !funding.termsMatchChain ||
    !funding.payerLinked ||
    !funding.receiverLinked
  )
    throw new Error(`The fold's funding is off: ${JSON.stringify(funding)}`)
  return quote
}

/** The worker publishes a delivery note and its wallet signs the delivery hash onto the chain; the fold says delivered. */
const delivered = async (world: EventsWorld, label: string, deal: Deal) => {
  const api = anyone(world.url)
  await api.publish(await sign.note(world.worker, deal.request, deliveryHash))
  const path = `/api/index/jobs/${deal.request.id}/delivery`
  const typed = bodyOf(TypedData, await api.get(`${path}?deliveryHash=${deliveryHash}`), 'delivery to sign')
  const signature = await signTyped(world.worker.wallet, typed)
  const relayed = bodyOf(Relayed, await api.post(path, { deliveryHash, signature }), 'delivery')
  step(world.evidence, {
    case: label,
    step: 'worker published a delivery note; its wallet signed the delivery hash, relayed',
    transactionHash: relayed.transactionHash,
  })
  const view = await folded(world, deal, label, 'delivered')
  if (!view.deliveryNotes.some((note) => note.fromWorker && note.matchesChain))
    throw new Error('The fold has no worker’s delivery note matching the chain')
}

/** The buyer's wallet signs `kind` of the delivery, relayed. */
const decided = async (world: EventsWorld, label: string, deal: Deal, kind: 'approval' | 'rejection') => {
  const api = anyone(world.url)
  const path = `/api/index/jobs/${deal.request.id}/${kind}`
  const signature = await signTyped(world.buyer.wallet, bodyOf(TypedData, await api.get(path), `${kind} to sign`))
  const relayed = bodyOf(Relayed, await api.post(path, { signature }), kind)
  step(world.evidence, {
    case: label,
    step: `buyer’s wallet signed the ${kind}, relayed`,
    transactionHash: relayed.transactionHash,
  })
}

const result =
  (label: string, title: string, started: number, deal: Deal, view: JobView, quote: IndexFunding) =>
  (rows: CaseResult['balances']): CaseResult => ({
    case: label,
    title,
    status: 'passed',
    job: deal.request.id,
    paymentHash: quote.paymentHash,
    outcome: view.stage,
    settlement: view.ending === null ? [] : [JSON.stringify(view.ending)],
    durationMs: Date.now() - started,
    ...(rows === undefined ? {} : { balances: rows }),
  })

/** (a) Funded, delivered, approved: released with the exact fee; the funded terms are served verbatim. */
export const releasedOnApproval = async (world: EventsWorld): Promise<CaseResult> => {
  const started = Date.now()
  const before = await balances(world)
  const deal = await agreed(world, 'a', 2 * hour)
  const quote = await funded(world, 'a', deal)
  await delivered(world, 'a', deal)
  await decided(world, 'a', deal, 'approval')
  const view = await folded(world, deal, 'a', 'released')
  const { amount } = world.chain
  const ending = view.ending
  if (!Predicate.isTagged(ending, 'Settled') || ending.feeAmount !== String(fee(amount)))
    throw new Error(`Released, yet ${JSON.stringify(view.ending)}`)
  const rows = await settled(world, before, { buyer: -amount, worker: amount - fee(amount), treasury: fee(amount) })
  const api = anyone(world.url)
  const terms = await eventually(
    () => api.get(`/api/index/jobs/${deal.request.id}/terms`),
    (reply) => reply.status === 200,
  )
  if (!Bun.deepEquals(bodyOf(FundedTerms, terms, 'terms'), { request: deal.request, proposal: deal.proposal }))
    throw new Error('The kept terms are not the signed events')
  const status = bodyOf(IndexPaymentStatus, await api.get(`/api/index/jobs/${deal.request.id}/payment`), 'payment')
  step(world.evidence, {
    case: 'a',
    step: 'the signed request and proposal are served verbatim; the payment reads Settled',
    detail: { stage: status.stage, outcome: status.outcome ?? 'none', relayed: status.relayed.length },
  })
  return result('a', 'released on approval with the exact fee', started, deal, view, quote)(rows)
}

/** (b) Rejected; the arbitration key's NIP-98 authorization asks for a 60 % ruling: ruled, both paid their share. */
export const ruledAfterRejection = async (world: EventsWorld): Promise<CaseResult> => {
  const started = Date.now()
  const before = await balances(world)
  const deal = await agreed(world, 'b', 2 * hour)
  const quote = await funded(world, 'b', deal)
  await delivered(world, 'b', deal)
  await decided(world, 'b', deal, 'rejection')
  const api = anyone(world.url)
  await api.publish(await sign.rejectionReason(world.buyer, deal.request))
  await folded(world, deal, 'b', 'rejected')
  const path = `/api/index/jobs/${deal.request.id}/ruling`
  const refused = await api.postAuthorized(path, { workerShareBps: 6000 }, world.buyer.key)
  if (refused.status !== 401) throw new Error(`A ruling by the buyer's key answered ${refused.status}`)
  const ruled = bodyOf(
    Relayed,
    await api.postAuthorized(path, { workerShareBps: 6000 }, world.arbitration.key),
    'ruling',
  )
  step(world.evidence, {
    case: 'b',
    step: 'a ruling authorized by the buyer’s key was refused (401); the arbitration key’s 6000 bps ruling relayed',
    transactionHash: ruled.transactionHash,
  })
  const view = await folded(world, deal, 'b', 'ruled')
  const ending = view.ending
  if (!Predicate.isTagged(ending, 'Settled') || ending.workerShareBps !== 6000)
    throw new Error(`Ruled, yet ${JSON.stringify(view.ending)}`)
  const captured = (world.chain.amount * 6000n) / 10_000n
  const rows = await settled(world, before, {
    buyer: -captured,
    worker: captured - fee(captured),
    treasury: fee(captured),
  })
  return result('b', 'rejected, then ruled through NIP-98', started, deal, view, quote)(rows)
}

/** Funded jobs nothing will be delivered for: (c)'s, refunded by the settler, and (d)'s, whose calls are withheld. */
export interface UndeliveredDeals {
  readonly refund: { readonly deal: Deal; readonly quote: IndexFunding }
  readonly reclaim: { readonly deal: Deal; readonly quote: IndexFunding }
}

export const fundUndeliveredDeals = async (world: EventsWorld, deadlineIn: number): Promise<UndeliveredDeals> => {
  const refundDeal = await agreed(world, 'c', deadlineIn)
  const refundQuote = await funded(world, 'c', refundDeal)
  const reclaimDeal = await agreed(world, 'd', deadlineIn)
  const reclaimQuote = await funded(world, 'd', reclaimDeal)
  if (!isHex(reclaimQuote.paymentHash)) throw new Error('A payment hash is hex')
  world.proxy.withheld.add(reclaimQuote.paymentHash)
  step(world.evidence, {
    case: 'd',
    step: 'the node now refuses every settlement call for this payment',
    detail: { paymentHash: reclaimQuote.paymentHash },
  })
  return { refund: { deal: refundDeal, quote: refundQuote }, reclaim: { deal: reclaimDeal, quote: reclaimQuote } }
}

/** (c) Never delivered: once the chain's time passes the deadline, the settler relays `refundUndelivered`. */
export const refundedBySettler = async (world: EventsWorld, deals: UndeliveredDeals): Promise<CaseResult> => {
  const started = Date.now()
  const before = await balances(world)
  const { deal, quote } = deals.refund
  await passTime(world, deal.terms.deliveryDeadline)
  step(world.evidence, {
    case: 'c',
    step: 'the delivery deadline passed on chain',
    detail: { deadline: deal.terms.deliveryDeadline },
  })
  const view = await folded(world, deal, 'c', 'refunded', 300)
  const ending = view.ending
  if (!Predicate.isTagged(ending, 'Settled') || ending.outcome !== 'Undelivered')
    throw new Error(`Refunded, yet ${JSON.stringify(view.ending)}`)
  const rows = await settled(world, before, { buyer: world.chain.amount, worker: 0n, treasury: 0n })
  return result('c', 'never delivered, refunded by the settler', started, deal, view, quote)(rows)
}

/** The quote's payment as the escrow takes it. */
const infoOf = (info: IndexFunding['paymentInfo']): PaymentInfo => ({
  ...info,
  operator: getAddress(info.operator),
  payer: getAddress(info.payer),
  receiver: getAddress(info.receiver),
  token: getAddress(info.token),
  feeReceiver: getAddress(info.feeReceiver),
  maxAmount: BigInt(info.maxAmount),
  salt: BigInt(info.salt),
})

/** (d) Settlement withheld until the escrow expires: the buyer reclaims on the escrow directly; the fold says reclaimed. */
export const reclaimedByBuyer = async (world: EventsWorld, deals: UndeliveredDeals): Promise<CaseResult> => {
  const started = Date.now()
  const before = await balances(world)
  const { deal, quote } = deals.reclaim
  await passTime(world, deal.terms.deliveryDeadline)
  await eventually(
    async () => world.proxy.sent.filter((sent) => sent.withheld).length,
    (count) => count > 0,
    300,
  )
  step(world.evidence, { case: 'd', step: 'the settler tried refundUndelivered; the node refused it' })
  await passTime(world, quote.paymentInfo.authorizationExpiry)
  const hash = await reclaimFromEscrow(world, world.buyer.wallet, infoOf(quote.paymentInfo))
  step(world.evidence, {
    case: 'd',
    step: 'after the escrow expired the buyer reclaimed on the escrow directly',
    transactionHash: hash,
  })
  const view = await folded(world, deal, 'd', 'reclaimed', 300)
  const rows = await settled(world, before, { buyer: world.chain.amount, worker: 0n, treasury: 0n })
  return result('d', 'settlement withheld until expiry, reclaimed by the buyer', started, deal, view, quote)(rows)
}
