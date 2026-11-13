import type { JobView } from '@sidequest/fold'
import { NostrEvent } from '@sidequest/nostr'
import { FundedTerms, EscrowFunding, Relayed, Terms, TypedData, UsdcOnArcTestnet } from '@sidequest/protocol'
import { sidequestOperatorAbi } from '@sidequest/settlement/abi/SidequestOperator'
import type { PaymentInfo } from '@sidequest/settlement/Payment'
import { Predicate, Schema } from 'effect'
import { getAddress, isHex } from 'viem'
import { balances, confirmedOnChain, passTime, reclaimFromEscrow, settled, type Wallets } from './ChainSteps.ts'
import type { CaseChain } from './Chain.ts'
import { type CaseResult, type Evidence, step } from './Evidence.ts'
import type { GatewayAgent } from './GatewayAgent.ts'
import { anyone, foldedJob, type NostrPerson, sign } from './Nostr.ts'
import { paymentReadBack } from './PaymentReadBack.ts'
import type { RpcProxy } from './RpcProxy.ts'
import { bodyOf, eventually, signTyped } from './Surfaces.ts'

// The hires of the phase 2 technical gate (ROADMAP: "two keys complete an escrowed hire through signed events, the
// website and the gateway, including a rejection settled by a ruling, with no session and no server-held chat"). The
// buyer is a person's key and wallet over HTTP (`POST /api/events` and the escrow endpoints); the worker
// acts through their agent at the gateway, an MCP client over OAuth whose key signs under the worker's grant, and the
// worker's wallet signs only money. No sign-in, no session cookie. The job's stage is the index's fold of its events
// and the chain's logs, asserted at every step, after the chain confirmed each relayed transaction.

export interface GateWorld extends Wallets {
  readonly url: string
  readonly chain: CaseChain
  /** The node proxy the stack reaches the chain through, where the rehearsal deployed it; none on a deployed stage. */
  readonly proxy: RpcProxy | undefined
  readonly buyer: NostrPerson
  readonly worker: NostrPerson
  /** The worker's agent at the gateway, granted `propose` and `deliver`. */
  readonly workerAgent: GatewayAgent
  /** Holds the stage's arbitration key, the only key whose NIP-98 authorization asks for a ruling; none, (b) cannot run. */
  readonly arbitration: NostrPerson | undefined
  readonly pace: Pace
  readonly evidence: Evidence
}

/**
 * How the rehearsal waits on the stage: it reads every `readMillis` while it waits, and gives the stage `factSeconds`
 * to show a chain fact the chain has confirmed.
 */
export interface Pace {
  readonly readMillis: number
  readonly factSeconds: number
}

/** A stack the rehearsal deployed itself, in local workerd: read it every 100 ms, give it 150 s for a chain fact. */
export const localPace: Pace = { readMillis: 100, factSeconds: 150 }

const hour = 3600
const deliveryHash = '0x9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'
const fee = (captured: bigint) => (captured * 500n) / 10_000n

/** A job of the rehearsal: its request, the agent's proposal the buyer accepted and that proposal's terms. */
interface Deal {
  readonly request: NostrEvent
  readonly proposal: NostrEvent
  readonly terms: Terms
}

/** The index's fold of the deal once it says `stage`, within `seconds` (the pace's time for a chain fact). */
const folded = (world: GateWorld, deal: Deal, label: string, stage: JobView['stage'], seconds?: number) => {
  const started = Date.now()
  const { readMillis, factSeconds } = world.pace
  const done = (view: JobView) => view.stage === stage
  return foldedJob(world.url, deal.request.id, done, seconds ?? factSeconds, readMillis).then((view) => {
    const waited = Math.round((Date.now() - started) / 100) / 10
    step(world.evidence, {
      case: label,
      step: `the index's fold says ${stage}`,
      detail: { job: deal.request.id, seconds: waited },
    })
    return view
  })
}

/** Which key signed an event, by role, for the evidence. */
const signer = (world: GateWorld, pubkey: string) =>
  pubkey === world.buyer.pubkey
    ? 'buyer’s key'
    : pubkey === world.workerAgent.pubkey
      ? 'worker’s agent’s key (gateway)'
      : pubkey === world.worker.pubkey
        ? 'worker’s key'
        : pubkey

const Proposed = Schema.Struct({ proposal: Schema.String, payTo: Schema.String, signedBy: Schema.String })
const OpenPage = Schema.Struct({ items: Schema.Array(Schema.Struct({ job: Schema.String })) })

/**
 * The buyer posts a request; the worker's agent finds it and proposes over MCP; the buyer accepts the agent's proposal:
 * the fold says accepted, the proposal its operator's (the worker's).
 */
const agreed = async (world: GateWorld, label: string, deadlineIn: number): Promise<Deal> => {
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
  await eventually(
    async () => Schema.decodeUnknownSync(OpenPage)(await world.workerAgent.call('list_open_requests', { limit: 50 })),
    (page) => page.items.some(({ job }) => job === request.id),
    60,
    world.pace.readMillis,
  )
  const proposed = Schema.decodeUnknownSync(Proposed)(
    await world.workerAgent.call('propose', {
      job: request.id,
      terms: Schema.encodeSync(Terms)(terms),
      validUntil: Math.floor(Date.now() / 1000) + 86_400,
    }),
  )
  if (proposed.payTo !== world.worker.account) throw new Error(`The agent's proposal pays ${proposed.payTo}`)
  const proposal = bodyOf(NostrEvent, await api.get(`/api/events/${proposed.proposal}`), 'the agent’s proposal')
  const accept = await sign.accept(world.buyer, request, proposal, terms, proposal.pubkey)
  await api.publish(accept)
  step(world.evidence, {
    case: label,
    step: 'buyer published a request (POST /api/events); the worker’s agent found it and proposed over MCP; buyer accepted',
    detail: {
      job: request.id,
      proposal: proposal.id,
      request: signer(world, request.pubkey),
      proposalSignedBy: signer(world, proposal.pubkey),
      proposalGrant: world.workerAgent.grant,
      payTo: proposed.payTo,
      accept: signer(world, accept.pubkey),
      gateway: 'MCP list_open_requests, propose',
    },
  })
  const deal = { request, proposal, terms }
  const view = await folded(world, deal, label, 'accepted')
  const shown = view.proposals.find(({ id }) => id === proposal.id)
  if (shown?.by !== 'agent' || shown.operator !== world.worker.pubkey || !shown.accepted)
    throw new Error(`The fold does not count the agent's proposal as the worker's: ${JSON.stringify(shown)}`)
  return deal
}

/**
 * The buyer's wallet signs the authorization the server quotes and the server relays `fund`; the fold says funded.
 * Before it signs, the quote must name the expected parties, operator, fee receiver, escrow and chain: on a stage the
 * rehearsal did not deploy, this is what keeps it from signing for another chain or operator.
 */
const funded = async (world: GateWorld, label: string, deal: Deal) => {
  const api = anyone(world.url)
  const path = `/api/index/jobs/${deal.request.id}/proposals/${deal.proposal.id}/funding`
  const quote = bodyOf(EscrowFunding, await api.get(`${path}?payer=${world.buyer.wallet.address}`), 'quote')
  const shown: ReadonlyArray<readonly [string, string, string]> = [
    ['payer', quote.paymentInfo.payer, world.buyer.wallet.address],
    ['receiver', quote.paymentInfo.receiver, world.worker.wallet.address],
    ['operator', quote.paymentInfo.operator, world.chain.operator],
    ['feeReceiver', quote.paymentInfo.feeReceiver, world.chain.treasury],
    ['amount', quote.amount, String(world.chain.amount)],
    ['jobId', quote.jobParams.jobId, `0x${deal.request.id}`],
    ['escrow', quote.escrow, world.chain.escrow],
    ['network', quote.network, UsdcOnArcTestnet.network],
    ['chainId', String(quote.typedData.domain.chainId), '5042002'],
  ]
  for (const [field, actual, expected] of shown)
    if (actual.toLowerCase() !== expected.toLowerCase()) throw new Error(`The quote's ${field} is ${actual}`)
  const signature = await signTyped(world.buyer.wallet, quote.typedData)
  const relayed = bodyOf(Relayed, await api.post(path, { payer: world.buyer.wallet.address, signature }), 'funding')
  step(world.evidence, {
    case: label,
    step: 'buyer’s wallet signed the authorization; the relayer funded the escrow to the worker’s wallet (no session)',
    transactionHash: relayed.transactionHash,
    detail: { paymentHash: quote.paymentHash, authorizationExpiry: quote.paymentInfo.authorizationExpiry },
  })
  await confirmedOnChain(world, label, 'funding', relayed.transactionHash)
  const view = await folded(world, deal, label, 'funded')
  const funding = view.funding
  if (
    funding?.proposal !== deal.proposal.id ||
    view.worker !== world.worker.pubkey ||
    !funding.termsMatchChain ||
    !funding.payerLinked ||
    !funding.receiverLinked
  )
    throw new Error(`The fold's funding is off: ${JSON.stringify({ worker: view.worker, funding })}`)
  return quote
}

const AwaitingWallet = Schema.Struct({
  note: Schema.String,
  signedBy: Schema.String,
  onChain: Schema.Struct({ signer: Schema.Literal('operator-wallet'), typedData: TypedData }),
})
const ByDelegate = Schema.Struct({
  note: Schema.String,
  signedBy: Schema.String,
  onChain: Schema.Struct({ signer: Schema.Literal('agent-delegate'), transactionHash: Schema.String }),
})

/** The fold shows the delivery, and the agent's note counts as the worker's and matches the chain. */
const deliveredInFold = async (world: GateWorld, label: string, deal: Deal, note: string) => {
  const view = await folded(world, deal, label, 'delivered')
  const shown = view.deliveryNotes.find(({ id }) => id === note)
  if (shown === undefined || !shown.fromWorker || !shown.matchesChain || shown.by !== 'agent')
    throw new Error(`The fold does not count the agent's delivery note: ${JSON.stringify(shown)}`)
}

/**
 * The worker's agent delivers over MCP: it publishes a delivery note and answers the typed data the worker's wallet must
 * sign, which it signs and the server relays; the fold says delivered.
 */
const delivered = async (world: GateWorld, label: string, deal: Deal) => {
  const api = anyone(world.url)
  const asked = { job: deal.request.id, deliveryHash, url: 'https://files.example/logo.svg' }
  const handed = Schema.decodeUnknownSync(AwaitingWallet)(await world.workerAgent.call('deliver', asked))
  const signature = await signTyped(world.worker.wallet, handed.onChain.typedData)
  const path = `/api/index/jobs/${deal.request.id}/delivery`
  const relayed = bodyOf(Relayed, await api.post(path, { deliveryHash, signature }), 'delivery')
  step(world.evidence, {
    case: label,
    step: 'the worker’s agent published a delivery note over MCP; the worker’s wallet signed the typed data it answered, relayed',
    transactionHash: relayed.transactionHash,
    detail: { note: handed.note, noteSignedBy: signer(world, handed.signedBy), gateway: 'MCP deliver' },
  })
  await confirmedOnChain(world, label, 'delivery', relayed.transactionHash)
  await deliveredInFold(world, label, deal, handed.note)
}

/** The buyer's wallet signs `kind` of the delivery, relayed and confirmed. */
const decided = async (world: GateWorld, label: string, deal: Deal, kind: 'approval' | 'rejection') => {
  const api = anyone(world.url)
  const path = `/api/index/jobs/${deal.request.id}/${kind}`
  const signature = await signTyped(world.buyer.wallet, bodyOf(TypedData, await api.get(path), `${kind} to sign`))
  const relayed = bodyOf(Relayed, await api.post(path, { signature }), kind)
  step(world.evidence, {
    case: label,
    step: `buyer’s wallet signed the ${kind}, relayed`,
    transactionHash: relayed.transactionHash,
  })
  await confirmedOnChain(world, label, kind, relayed.transactionHash)
}

const result =
  (label: string, title: string, started: number, deal: Deal, view: JobView, quote: EscrowFunding) =>
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

/** (a) The agent proposes; funded, delivered, approved: released with the exact fee; the funded terms served verbatim. */
export const releasedOnApproval = async (world: GateWorld): Promise<CaseResult> => {
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
    60,
    world.pace.readMillis,
  )
  if (!Bun.deepEquals(bodyOf(FundedTerms, terms, 'terms'), { request: deal.request, proposal: deal.proposal }))
    throw new Error('The kept terms are not the signed events')
  step(world.evidence, { case: 'a', step: 'the signed request and the agent’s proposal are served verbatim' })
  await paymentReadBack(world, 'a', deal.request.id, 'Approved')
  return result('a', 'agent proposes, released on approval with the exact fee', started, deal, view, quote)(rows)
}

/** (b) Rejected; the arbitration key's NIP-98 authorization asks for a 60 % ruling: ruled, both paid their share. */
export const ruledAfterRejection = async (world: GateWorld): Promise<CaseResult> => {
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
  if (world.arbitration === undefined) throw new Error('(b) needs the stage’s arbitration key')
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
  await confirmedOnChain(world, 'b', 'ruling', ruled.transactionHash)
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
  await paymentReadBack(world, 'b', deal.request.id, 'Ruled')
  return result('b', 'rejected, then ruled through NIP-98', started, deal, view, quote)(rows)
}

/**
 * (e) The worker's wallet signs one delegation to the agent's key and the worker stores it at the gateway (NIP-98);
 * the agent's `deliver` then records the delivery on chain itself, with no wallet signature; the logs name its key as
 * the delegate, and the buyer's approval pays the worker.
 */
export const releasedAfterDelegatedDelivery = async (world: GateWorld): Promise<CaseResult> => {
  const started = Date.now()
  const before = await balances(world)
  const deal = await agreed(world, 'e', 2 * hour)
  const quote = await funded(world, 'e', deal)
  const api = anyone(world.url)
  const { delegate } = world.workerAgent
  const expiry = (await world.chain.now()) + 2 * hour
  const job = deal.request.id
  const toDelegate = bodyOf(
    TypedData,
    await api.get(`/api/index/jobs/${job}/delivery-delegation?delegate=${delegate}&expiry=${expiry}`),
    'delegation to sign',
  )
  await world.workerAgent.storeDelegation(job, await signTyped(world.worker.wallet, toDelegate), expiry)
  step(world.evidence, {
    case: 'e',
    step: 'worker’s wallet signed one DeliveryDelegate to the agent’s key; the worker stored it at the gateway (NIP-98)',
    detail: { delegate, expiry },
  })
  const asked = { job, deliveryHash, url: 'https://files.example/logo.svg' }
  const handed = Schema.decodeUnknownSync(ByDelegate)(await world.workerAgent.call('deliver', asked))
  const { transactionHash } = handed.onChain
  step(world.evidence, {
    case: 'e',
    step: 'the worker’s agent delivered over MCP, unattended: its key signed the delivery, relayed with no wallet signature',
    transactionHash,
    detail: {
      note: handed.note,
      noteSignedBy: signer(world, handed.signedBy),
      gateway: 'MCP deliver (agent-delegate)',
    },
  })
  await confirmedOnChain(world, 'e', 'delegated delivery', transactionHash)
  if (!isHex(transactionHash) || !isHex(quote.paymentHash)) throw new Error('Hashes are hex')
  const { blockNumber } = await world.chain.client.getTransactionReceipt({ hash: transactionHash })
  const logged = await world.chain.client.getContractEvents({
    address: world.chain.operator,
    abi: sidequestOperatorAbi,
    eventName: 'JobDeliveryDelegated',
    args: { paymentInfoHash: quote.paymentHash },
    fromBlock: blockNumber,
    toBlock: blockNumber,
  })
  if (logged.length !== 1 || logged[0]?.args.delegate?.toLowerCase() !== delegate.toLowerCase())
    throw new Error(`The chain logged ${logged.length} delegated deliveries for the payment`)
  step(world.evidence, { case: 'e', step: 'JobDeliveryDelegated names the agent’s key as the delegate' })
  await deliveredInFold(world, 'e', deal, handed.note)
  await decided(world, 'e', deal, 'approval')
  const view = await folded(world, deal, 'e', 'released')
  const { amount } = world.chain
  const rows = await settled(world, before, { buyer: -amount, worker: amount - fee(amount), treasury: fee(amount) })
  await paymentReadBack(world, 'e', deal.request.id, 'Approved')
  return result('e', 'delivered by the agent’s key under one delegation, approved', started, deal, view, quote)(rows)
}

/** Funded jobs nothing will be delivered for: (c)'s, refunded by the settler, and (d)'s, whose calls are withheld. */
export interface UndeliveredDeals {
  readonly refund: { readonly deal: Deal; readonly quote: EscrowFunding }
  readonly reclaim: { readonly deal: Deal; readonly quote: EscrowFunding } | undefined
}

/**
 * Agree and fund (c)'s job and, with `reclaim`, (d)'s. Only (d)'s payment is withheld; where (d) does not run its job
 * is never funded, so a live chain keeps no withheld escrow.
 */
export const fundUndeliveredDeals = async (
  world: GateWorld,
  deadlineIn: number,
  reclaim: boolean,
): Promise<UndeliveredDeals> => {
  const refundDeal = await agreed(world, 'c', deadlineIn)
  const refund = { deal: refundDeal, quote: await funded(world, 'c', refundDeal) }
  if (!reclaim) return { refund, reclaim: undefined }
  const reclaimDeal = await agreed(world, 'd', deadlineIn)
  const reclaimQuote = await funded(world, 'd', reclaimDeal)
  if (!isHex(reclaimQuote.paymentHash)) throw new Error('A payment hash is hex')
  if (world.proxy === undefined) throw new Error('(d) withholds calls at the node proxy, and there is none')
  world.proxy.withheld.add(reclaimQuote.paymentHash)
  step(world.evidence, {
    case: 'd',
    step: 'the node now refuses every settlement call for this payment',
    detail: { paymentHash: reclaimQuote.paymentHash },
  })
  return { refund, reclaim: { deal: reclaimDeal, quote: reclaimQuote } }
}

/**
 * (c) Never delivered: once the chain's time passes the deadline, the settler relays `refundUndelivered`. `seconds`
 * bounds the wait for the fold to say refunded, after the deadline passed on chain.
 */
export const refundedBySettler = async (
  world: GateWorld,
  deals: UndeliveredDeals,
  seconds: number,
): Promise<CaseResult> => {
  const started = Date.now()
  const before = await balances(world)
  const { deal, quote } = deals.refund
  await passTime(world, deal.terms.deliveryDeadline)
  const passed = Date.now()
  step(world.evidence, {
    case: 'c',
    step: 'the delivery deadline passed on chain',
    detail: { deadline: deal.terms.deliveryDeadline },
  })
  const view = await folded(world, deal, 'c', 'refunded', seconds)
  step(world.evidence, {
    case: 'c',
    step: 'the settler refunded it on its Cron Trigger; the chain log poller recorded the refund',
    detail: { secondsAfterDeadline: Math.round((Date.now() - passed) / 1000), budget: seconds },
  })
  const ending = view.ending
  if (!Predicate.isTagged(ending, 'Settled') || ending.outcome !== 'Undelivered')
    throw new Error(`Refunded, yet ${JSON.stringify(view.ending)}`)
  const rows = await settled(world, before, { buyer: world.chain.amount, worker: 0n, treasury: 0n })
  await paymentReadBack(world, 'c', deal.request.id, 'Undelivered')
  return result('c', 'never delivered, refunded by the settler', started, deal, view, quote)(rows)
}

/** The quote's payment as the escrow takes it. */
const infoOf = (info: EscrowFunding['paymentInfo']): PaymentInfo => ({
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
export const reclaimedByBuyer = async (world: GateWorld, deals: UndeliveredDeals): Promise<CaseResult> => {
  const started = Date.now()
  const before = await balances(world)
  if (deals.reclaim === undefined) throw new Error('The job of (d) was not funded')
  const { deal, quote } = deals.reclaim
  await passTime(world, deal.terms.deliveryDeadline)
  const { proxy } = world
  if (proxy === undefined) throw new Error('(d) withholds calls at the node proxy, and there is none')
  await eventually(
    async () => proxy.sent.filter((sent) => sent.withheld).length,
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
