import { type BuyerJobView, type FundingRequest, type JobId, Relayed } from '@sidequest/protocol'
import { paymentInfoHash, paymentOf } from '@sidequest/settlement/Payment'
import { arcTestnet } from '@sidequest/settlement/SettlementChain'
import { Effect } from 'effect'
import { type Address, encodeFunctionData, getAddress, isHex, parseAbi } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { type Balance, type CaseResult, step } from './Evidence.ts'
import { award, buyerView, decide, deliver, fund, type World } from './Hire.ts'
import { bodyOf, eventually, inboxOf } from './Surfaces.ts'

// The four hires of the phase 1 technical gate (docs/ROADMAP.md): paid on approval, split by a ruling, refunded when
// nothing was delivered, and reclaimed by the buyer from the escrow after settlement calls were withheld until it
// expired. Each asserts the chain's balances, the job's end through the API and both parties' inboxes.

const hour = 3600
const fee = (world: World, captured: bigint) => (captured * 500n) / 10_000n

type Party = 'buyer' | 'worker' | 'treasury'

const addressOf = (world: World, party: Party): Address =>
  party === 'buyer'
    ? world.buyer.wallet.address
    : party === 'worker'
      ? world.worker.wallet.address
      : world.chain.treasury

/** Balances of the three parties now, to compare with after. */
const balances = async (world: World) => {
  const parties: ReadonlyArray<Party> = ['buyer', 'worker', 'treasury']
  return new Map(
    await Promise.all(
      parties.map(async (party) => [party, await world.chain.balanceOf(addressOf(world, party))] as const),
    ),
  )
}

/** Each party's change in balance, checked against what the case expects. */
const settled = async (world: World, before: Map<Party, bigint>, expected: Readonly<Record<Party, bigint>>) => {
  const after = await balances(world)
  const rows: Array<Balance> = (['buyer', 'worker', 'treasury'] as const).map((party) => {
    const was = before.get(party) ?? 0n
    const now = after.get(party) ?? 0n
    return {
      party,
      address: addressOf(world, party),
      before: String(was),
      after: String(now),
      change: String(now - was),
      expected: String(expected[party]),
    }
  })
  const wrong = rows.filter((row) => row.change !== row.expected)
  if (wrong.length > 0) throw new Error(`Balances off: ${JSON.stringify(wrong)}`)
  return rows
}

/** Both parties' inbox items for `job`, by kind, once each holds `kinds`. */
const inboxes = async (
  world: World,
  job: JobId,
  kinds: { readonly buyer: ReadonlyArray<string>; readonly worker: ReadonlyArray<string> },
) => {
  const of = async (person: World['buyer'], wanted: ReadonlyArray<string>) =>
    eventually(
      async () => (await inboxOf(person)).filter((item) => item.job === job).map(({ kind }): string => kind),
      (found) => wanted.every((kind) => found.includes(kind)),
    )
  return { buyer: await of(world.buyer, kinds.buyer), worker: await of(world.worker, kinds.worker) }
}

const result = (
  name: string,
  title: string,
  started: number,
  job: JobId,
  view: BuyerJobView,
  extra: Pick<CaseResult, 'balances' | 'inbox' | 'paymentHash'>,
): CaseResult => ({
  case: name,
  title,
  status: 'passed',
  job,
  outcome: view.outcome ?? 'none',
  settlement: view.settlement.map((receipt) => `${receipt.operation} ${receipt.amount}`),
  durationMs: Date.now() - started,
  ...extra,
})

const settledKinds = {
  buyer: ['proposal_submitted', 'funding_recorded', 'job_settled'],
  worker: ['proposal_accepted', 'funding_recorded', 'job_settled'],
}
const deliveredKinds = {
  buyer: [...settledKinds.buyer, 'delivery_recorded'],
  worker: [...settledKinds.worker, 'delivery_recorded'],
}

/** (a) The worker's agent proposes, the buyer funds, the work is delivered and approved: paid, less the exact fee. */
export const paidOnApproval = async (world: World): Promise<CaseResult> => {
  const started = Date.now()
  const before = await balances(world)
  const job = await award(world, 'a', 2 * hour)
  const funding = await fund(world, 'a', job)
  await deliver(world, 'a', job)
  await decide(world, 'a', job, 'approval')
  const view = await buyerView(world, job, (shown) => shown.state === 'Settled')
  if (view.outcome !== 'paid') throw new Error(`Approved, yet ${view.outcome}`)
  const { amount } = world.chain
  const rows = await settled(world, before, {
    buyer: -amount,
    worker: amount - fee(world, amount),
    treasury: fee(world, amount),
  })
  const status = await world.workerAgent.call('payment_status', { job })
  step(world.evidence, {
    case: 'a',
    step: 'worker agent read the payment as settled (MCP payment_status)',
    detail: { status: JSON.stringify(status).includes('"Settled"') },
  })
  return result('a', 'approved and paid with the exact fee', started, job, view, {
    balances: rows,
    inbox: await inboxes(world, job, deliveredKinds),
    paymentHash: funding.paymentHash,
  })
}

/** (b) The buyer rejects the delivery; the arbitration operator rules a 60 % share: both get the right amounts. */
export const splitByRuling = async (world: World): Promise<CaseResult> => {
  const started = Date.now()
  const before = await balances(world)
  const job = await award(world, 'b', 2 * hour)
  const funding = await fund(world, 'b', job)
  await deliver(world, 'b', job)
  await decide(world, 'b', job, 'rejection')
  await buyerView(world, job, (shown) => shown.state === 'Disputed' && shown.dispute?.reason != null)
  const ruled = bodyOf(
    Relayed,
    await world.arbitration.post(`/api/jobs/${job}/ruling`, { workerShareBps: 6000 }),
    'ruling',
  )
  step(world.evidence, {
    case: 'b',
    step: 'the arbitration operator ruled a 6000 bps share (HTTP ruling)',
    transactionHash: ruled.transactionHash,
  })
  const view = await buyerView(world, job, (shown) => shown.state === 'Settled')
  if (view.outcome !== 'split' || view.dispute?.workerShareBps !== 6000) throw new Error(`Ruled, yet ${view.outcome}`)
  const captured = (world.chain.amount * 6000n) / 10_000n
  const rows = await settled(world, before, {
    buyer: -captured,
    worker: captured - fee(world, captured),
    treasury: fee(world, captured),
  })
  return result('b', 'rejected, then split by a ruling', started, job, view, {
    balances: rows,
    inbox: await inboxes(world, job, deliveredKinds),
    paymentHash: funding.paymentHash,
  })
}

/** Wait until the chain's clock passes `at`: move it where it can be moved, else wait for it. */
const passTime = async (world: World, at: number) => {
  const now = await world.chain.now()
  if (now > at) return
  if (world.chain.advance !== undefined) return world.chain.advance(at - now + 1)
  await eventually(
    () => world.chain.now(),
    (time) => time > at,
    at - now + 120,
  )
}

/** The escrow payment of a funded job, rebuilt from the agreement and checked against the hash the server showed. */
const paymentOfJob = async (world: World, job: JobId, funding: FundingRequest) => {
  const { agreement } = await buyerView(world, job, (shown) => shown.agreement !== null)
  if (agreement === null) throw new Error('No agreement')
  const chain = {
    ...arcTestnet({
      operator: world.chain.operator,
      feeReceiver: world.chain.treasury,
      arbitrator: privateKeyToAccount(world.chain.keys.arbitrator).address,
    }),
    escrow: world.chain.escrow,
    collector: world.chain.collector,
  }
  const payment = await Effect.runPromise(
    paymentOf(agreement, { payer: getAddress(funding.payer), receiver: getAddress(funding.receiver) }, chain),
  )
  if (paymentInfoHash(payment.info, chain) !== funding.paymentHash) throw new Error('The payment does not match')
  return payment
}

const reclaimAbi = parseAbi([
  'function reclaim((address operator, address payer, address receiver, address token, uint120 maxAmount, uint48 preApprovalExpiry, uint48 authorizationExpiry, uint48 refundExpiry, uint16 minFeeBps, uint16 maxFeeBps, address feeReceiver, uint256 salt) paymentInfo)',
])

/** Two funded jobs, one awaiting the saga's refund and one whose settlement calls the node withholds. */
export interface Undelivered {
  readonly refund: { readonly job: JobId; readonly funding: FundingRequest }
  readonly reclaim: { readonly job: JobId; readonly funding: FundingRequest }
}

/** Award and fund the jobs of (c) and (d); nothing will be delivered on either. */
export const fundUndelivered = async (world: World, deadlineIn: number): Promise<Undelivered> => {
  const refundJob = await award(world, 'c', deadlineIn)
  const refundFunding = await fund(world, 'c', refundJob)
  const reclaimJob = await award(world, 'd', deadlineIn)
  const reclaimFunding = await fund(world, 'd', reclaimJob)
  if (!isHex(reclaimFunding.paymentHash)) throw new Error('A payment hash is hex')
  world.proxy.withheld.add(reclaimFunding.paymentHash)
  step(world.evidence, {
    case: 'd',
    step: 'the node now refuses every settlement call for this payment',
    detail: { paymentHash: reclaimFunding.paymentHash },
  })
  return {
    refund: { job: refundJob, funding: refundFunding },
    reclaim: { job: reclaimJob, funding: reclaimFunding },
  }
}

/**
 * (c) Nothing was delivered by the deadline: the saga's `refundUndelivered` returns everything to the buyer. Balances
 * are measured from funding on, so the buyer's change is the refund.
 */
export const refundedUndelivered = async (world: World, funded: Undelivered): Promise<CaseResult> => {
  const started = Date.now()
  const before = await balances(world)
  const { job, funding } = funded.refund
  await passTime(world, funding.deliveryDeadline)
  step(world.evidence, {
    case: 'c',
    step: 'the delivery deadline passed on chain',
    detail: { deadline: funding.deliveryDeadline },
  })
  const view = await buyerView(world, job, (shown) => shown.state === 'Settled', 300)
  if (view.outcome !== 'refunded') throw new Error(`Undelivered, yet ${view.outcome}`)
  step(world.evidence, { case: 'c', step: 'the saga refunded it (refundUndelivered, relayed)' })
  const rows = await settled(world, before, { buyer: world.chain.amount, worker: 0n, treasury: 0n })
  return result('c', 'funded, never delivered, refunded by the saga', started, job, view, {
    balances: rows,
    inbox: await inboxes(world, job, settledKinds),
    paymentHash: funding.paymentHash,
  })
}

/**
 * (d) Settlement calls for the job are withheld until the escrow's `authorizationExpiry`; then the buyer reclaims on
 * the escrow directly, and the job ends refunded in the model. The withheld calls leave relayer nonces unused, which
 * the relayer must release so other jobs' transactions go through. Balances are measured from funding on: the buyer's
 * change is the reclaim (its gas is paid in the local chain's native coin, not the token).
 */
export const reclaimedAfterExpiry = async (world: World, funded: Undelivered): Promise<CaseResult> => {
  const started = Date.now()
  const before = await balances(world)
  const { job, funding } = funded.reclaim
  await passTime(world, funding.deliveryDeadline)
  await eventually(
    async () => world.proxy.sent.filter((sent) => sent.withheld).length,
    (count) => count > 0,
  )
  step(world.evidence, {
    case: 'd',
    step: 'the saga tried refundUndelivered; the node refused it',
    detail: { refused: world.proxy.sent.filter((sent) => sent.withheld).length },
  })
  const payment = await paymentOfJob(world, job, funding)
  await passTime(world, funding.authorizationExpiry)
  const buyer = world.buyer.wallet
  const hash = await world.chain.client.sendRawTransaction({
    serializedTransaction: await buyer.signTransaction({
      type: 'eip1559',
      chainId: 5042002,
      to: world.chain.escrow,
      data: encodeFunctionData({ abi: reclaimAbi, functionName: 'reclaim', args: [payment.info] }),
      nonce: await world.chain.client.getTransactionCount({ address: buyer.address, blockTag: 'pending' }),
      gas: 300_000n,
      ...(await world.chain.client.estimateFeesPerGas()),
    }),
  })
  const receipt = await world.chain.client.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error('The reclaim reverted')
  step(world.evidence, {
    case: 'd',
    step: 'after the escrow expired the buyer reclaimed on the escrow directly',
    transactionHash: hash,
  })
  const view = await buyerView(world, job, (shown) => shown.state === 'Settled', 120)
  if (view.outcome !== 'refunded' || !view.settlement.some(({ operation }) => operation === 'reclaim'))
    throw new Error(`Reclaimed, yet ${view.outcome}`)
  const rows = await settled(world, before, { buyer: world.chain.amount, worker: 0n, treasury: 0n })
  return result('d', 'settlement withheld until expiry, reclaimed by the buyer', started, job, view, {
    balances: rows,
    inbox: await inboxes(world, job, settledKinds),
    paymentHash: funding.paymentHash,
  })
}
