import {
  type BuyerJobView,
  Digest,
  FundingRequest,
  JobId,
  JobView,
  type Proposal,
  Relayed,
  TypedData,
  UsdcOnArcTestnet,
} from '@sidequest/protocol'
import { Option, Schema } from 'effect'
import { isHex } from 'viem'
import type { RehearsalChain } from './Chain.ts'
import { type Evidence, step } from './Evidence.ts'
import type { RpcProxy } from './RpcProxy.ts'
import { type Agent, bodyOf, eventually, type Person, signTyped } from './Surfaces.ts'

// The steps of a hire over the public surfaces: the buyer's agent posts and accepts over MCP, the worker's agent finds
// the request, proposes and hands over the work over MCP, and each person signs their own step (funding, the delivery
// hash, approval or rejection) on the website's HTTP API with their wallet.

export interface World {
  readonly url: string
  readonly chain: RehearsalChain
  readonly proxy: RpcProxy
  readonly buyer: Person
  readonly worker: Person
  readonly arbitration: Person
  readonly buyerAgent: Agent
  readonly workerAgent: Agent
  readonly evidence: Evidence
}

const hour = 3600
export const artifactHash = Digest.make('9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08')

/** The buyer's view of `job`, once it shows what `done` waits for. */
export const buyerView = (world: World, job: JobId, done: (view: BuyerJobView) => boolean, seconds = 60) =>
  eventually(
    async () => {
      const shown = bodyOf(JobView, await world.buyer.get(`/api/jobs/${job}`), 'job')
      return shown.audience === 'buyer' ? shown.view : undefined
    },
    (view) => view !== undefined && done(view),
    seconds,
  ).then((view) => Option.getOrThrow(Option.fromNullishOr(view)))

/** The latest of the chain's clock and the server's, in Unix seconds: deadlines must lie after both. */
const latest = async (world: World) => Math.max(await world.chain.now(), Math.floor(Date.now() / 1000))

const termsOf = (world: World, label: string, deliveryDeadline: number) => ({
  title: `Gate rehearsal: ${label}`,
  deliverables: ['A logo as SVG'],
  amount: String(world.chain.amount),
  asset: UsdcOnArcTestnet.id,
  network: UsdcOnArcTestnet.network,
  deliveryDeadline,
  reviewWindowSeconds: hour,
  disputeWindowSeconds: hour,
  arbitrationWindowSeconds: 12 * hour,
  rail: 'escrow',
})

const Posted = Schema.Struct({ job: JobId })
const OpenRequests = Schema.Struct({ items: Schema.Array(Schema.Struct({ id: JobId })) })
const NextStep = Schema.Struct({ nextAction: Schema.NullOr(Schema.Struct({ kind: Schema.String })) })
const AgentJob = Schema.Struct({ job: JobView })

/** The head proposal, as the buyer's agent reads the job over MCP. */
const proposalSeenByAgent = async (world: World, job: JobId) => {
  const read = await eventually(
    async () => Schema.decodeUnknownSync(AgentJob)(await world.buyerAgent.call('get_job', { job })).job,
    (shown) => shown.audience === 'buyer' && shown.view.proposals.length > 0,
  )
  const proposals: ReadonlyArray<Proposal> = read.audience === 'buyer' ? read.view.proposals : []
  const [head] = proposals
  if (head === undefined) throw new Error('No proposal reached the buyer')
  return head
}

/** How often the rehearsal asks the chain itself: about a block's time on Arc, well inside the public RPC's limit. */
export const chainPollMillis = 2000

/**
 * Wait until the chain holds the relayed `transactionHash` at the stack's confirmation depth, and record how long the
 * chain took. The stack reports only confirmed facts, so what a case then gives it (a view's 60 s) measures the stack,
 * however slowly the chain makes and confirms blocks: on 2026-11-13 Arc testnet's blocks came 3.9 s apart on average
 * and up to 30 s apart, against 0.55 s the day before, and inclusion plus three confirmations alone took up to 60 s.
 */
export const confirmedOnChain = async (
  world: Pick<World, 'chain' | 'evidence'>,
  label: string,
  what: string,
  transactionHash: string,
) => {
  const started = Date.now()
  if (!isHex(transactionHash)) throw new Error(`The ${what} has no transaction hash`)
  const depth = BigInt(Math.max(world.chain.confirmations, 1) - 1)
  const { client } = world.chain
  const confirmedIn = async () => {
    // A failed read (a rate limit, a timeout) is a read that found nothing yet: the next one asks again.
    const receipt = await client.getTransactionReceipt({ hash: transactionHash }).catch(() => undefined)
    if (receipt === undefined) return undefined
    const head = await client.getBlockNumber({ cacheTime: 0 }).catch(() => 0n)
    return head - receipt.blockNumber >= depth ? receipt : undefined
  }
  const receipt = await eventually(confirmedIn, (found) => found !== undefined, 600, chainPollMillis)
  if (receipt?.status !== 'success') throw new Error(`The ${what} reverted on chain`)
  step(world.evidence, {
    case: label,
    step: `the chain confirmed the ${what} (${world.chain.confirmations} blocks deep)`,
    transactionHash,
    detail: { block: Number(receipt.blockNumber), seconds: Math.round((Date.now() - started) / 100) / 10 },
  })
}

/**
 * The buyer's agent posts a request, the worker's agent finds it and proposes, the buyer's agent accepts: an awarded
 * job, whose delivery deadline lies `deadlineIn` seconds ahead.
 */
export const award = async (world: World, label: string, deadlineIn: number) => {
  const now = await latest(world)
  const { job } = Schema.decodeUnknownSync(Posted)(
    await world.buyerAgent.call('post_request', {
      title: `Gate rehearsal: ${label}`,
      description: 'A logo for a café, as SVG.',
      expiresAt: Math.floor(Date.now() / 1000) + 86_400,
    }),
  )
  step(world.evidence, { case: label, step: 'buyer agent posted the request (MCP post_request)', detail: { job } })
  await eventually(
    async () =>
      Schema.decodeUnknownSync(OpenRequests)(await world.workerAgent.call('list_open_requests', { limit: 50 })),
    (page) => page.items.some(({ id }) => id === job),
  )
  await world.workerAgent.call('propose', { job, terms: termsOf(world, label, now + deadlineIn) })
  step(world.evidence, { case: label, step: 'worker agent found it and proposed (MCP list_open_requests, propose)' })
  const head = await proposalSeenByAgent(world, job)
  const accepted = Schema.decodeUnknownSync(NextStep)(
    await world.buyerAgent.call('accept', {
      job,
      bidder: head.bidder,
      version: head.version,
      termsDigest: head.termsDigest,
    }),
  )
  if (accepted.nextAction?.kind !== 'fund_escrow') throw new Error('Accepting did not ask the buyer to fund')
  step(world.evidence, { case: label, step: 'buyer agent accepted; the buyer is asked to fund (MCP accept)' })
  await buyerView(world, job, (view) => view.state === 'Awarded')
  return job
}

/** The buyer signs the ERC-3009 authorization the server shows and funds the escrow; the chain then shows it funded. */
export const fund = async (world: World, label: string, job: JobId) => {
  const funding = bodyOf(FundingRequest, await world.buyer.get(`/api/jobs/${job}/funding`), 'funding request')
  // What the buyer is shown before signing must be this hire: these wallets, this operator, treasury and amount.
  const shown: ReadonlyArray<readonly [string, string, string]> = [
    ['payer', funding.payer, world.buyer.wallet.address],
    ['receiver', funding.receiver, world.worker.wallet.address],
    ['operator', funding.operator, world.chain.operator],
    ['feeReceiver', funding.feeReceiver, world.chain.treasury],
    ['amount', funding.amount, String(world.chain.amount)],
  ]
  for (const [field, actual, expected] of shown)
    if (actual.toLowerCase() !== expected.toLowerCase())
      throw new Error(`The funding request's ${field} is ${actual}, not ${expected}`)
  const signature = await signTyped(world.buyer.wallet, funding.typedData)
  const relayed = bodyOf(Relayed, await world.buyer.post(`/api/jobs/${job}/funding`, { signature }), 'funding')
  step(world.evidence, {
    case: label,
    step: 'buyer signed the authorization; the relayer funded the escrow (HTTP funding)',
    transactionHash: relayed.transactionHash,
    detail: { paymentHash: funding.paymentHash, authorizationExpiry: funding.authorizationExpiry },
  })
  await confirmedOnChain(world, label, 'funding', relayed.transactionHash)
  await buyerView(world, job, (view) => view.state === 'Funded')
  step(world.evidence, { case: label, step: 'the chain reader saw the funding; the job is Funded' })
  return funding
}

/** The worker's agent hands the work over; the worker signs its hash onto the chain; the job shows it delivered. */
export const deliver = async (world: World, label: string, job: JobId) => {
  const handed = Schema.decodeUnknownSync(NextStep)(
    await world.workerAgent.call('deliver', { job, artifactHash, url: 'https://files.example/logo.svg' }),
  )
  if (handed.nextAction?.kind !== 'sign_delivery') throw new Error('Delivering did not ask the worker to sign')
  step(world.evidence, { case: label, step: 'worker agent handed over the work (MCP deliver)' })
  const typed = bodyOf(TypedData, await world.worker.get(`/api/jobs/${job}/delivery/signature`), 'delivery to sign')
  const signature = await signTyped(world.worker.wallet, typed)
  const relayed = bodyOf(
    Relayed,
    await world.worker.post(`/api/jobs/${job}/delivery/signature`, { signature }),
    'delivery',
  )
  step(world.evidence, {
    case: label,
    step: 'worker signed the delivery hash (HTTP)',
    transactionHash: relayed.transactionHash,
  })
  await confirmedOnChain(world, label, 'delivery', relayed.transactionHash)
  await buyerView(world, job, (view) => view.state === 'Delivered')
}

/** The buyer signs `kind` (approval or rejection) of the delivery, and it is relayed. */
export const decide = async (world: World, label: string, job: JobId, kind: 'approval' | 'rejection') => {
  const typed = bodyOf(TypedData, await world.buyer.get(`/api/jobs/${job}/${kind}`), `${kind} to sign`)
  const signature = await signTyped(world.buyer.wallet, typed)
  const body = kind === 'approval' ? { signature } : { signature, reason: 'The favicon set is missing.' }
  const relayed = bodyOf(Relayed, await world.buyer.post(`/api/jobs/${job}/${kind}`, body), kind)
  step(world.evidence, {
    case: label,
    step: `buyer signed the ${kind} (HTTP)`,
    transactionHash: relayed.transactionHash,
  })
  await confirmedOnChain(world, label, kind, relayed.transactionHash)
}
