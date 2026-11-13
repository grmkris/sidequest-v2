import { type Address, encodeFunctionData, isHex, parseAbi } from 'viem'
import type { PrivateKeyAccount } from 'viem/accounts'
import type { PaymentInfo } from '@sidequest/settlement/Payment'
import type { RehearsalChain } from './Chain.ts'
import { type Balance, type Evidence, step } from './Evidence.ts'
import { eventually } from './Surfaces.ts'

// What every rehearsal does with the chain itself, beside the stack: measure balances, wait for a relayed transaction
// to be confirmed, move or wait out the chain's clock, and reclaim from the escrow as a payer's own wallet would.

interface OnChain {
  readonly chain: RehearsalChain
}

type Party = 'buyer' | 'worker' | 'treasury'

/** Whose balances a case measures: the buyer's and the worker's wallets, and the chain's treasury. */
export interface Wallets {
  readonly chain: RehearsalChain
  readonly buyer: { readonly wallet: { readonly address: Address } }
  readonly worker: { readonly wallet: { readonly address: Address } }
}

const addressOf = (world: Wallets, party: Party): Address =>
  party === 'buyer'
    ? world.buyer.wallet.address
    : party === 'worker'
      ? world.worker.wallet.address
      : world.chain.treasury

/** Balances of the three parties now, to compare with after. */
export const balances = async (world: Wallets) => {
  const parties: ReadonlyArray<Party> = ['buyer', 'worker', 'treasury']
  return new Map(
    await Promise.all(
      parties.map(async (party) => [party, await world.chain.balanceOf(addressOf(world, party))] as const),
    ),
  )
}

/** Each party's change in balance, checked against what the case expects. */
export const settled = async (
  world: Wallets,
  before: Map<Party, bigint>,
  expected: Readonly<Record<Party, bigint>>,
) => {
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

/** How often the rehearsal asks the chain itself: about a block's time on Arc, well inside the public RPC's limit. */
export const chainPollMillis = 2000

/**
 * Wait until the chain holds the relayed `transactionHash` at the stack's confirmation depth, and record how long the
 * chain took. The stack reports only confirmed facts, so what a case then gives it (a view's 60 s) measures the stack,
 * however slowly the chain makes and confirms blocks: on 2026-11-13 Arc testnet's blocks came 3.9 s apart on average
 * and up to 30 s apart, against 0.55 s the day before, and inclusion plus three confirmations alone took up to 60 s.
 */
export const confirmedOnChain = async (
  world: OnChain & { readonly evidence: Evidence },
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

/** Wait until the chain's clock passes `at`: move it where it can be moved, else wait for it. */
export const passTime = async (world: OnChain, at: number) => {
  const now = await world.chain.now()
  if (now > at) return
  if (world.chain.advance !== undefined) return world.chain.advance(at - now + 1)
  // A failed read (a rate limit, a timeout) reads as "not yet": the next one, a block later, asks again.
  await eventually(
    () => world.chain.now().catch(() => now),
    (time) => time > at,
    at - now + 120,
    chainPollMillis,
  )
}

const reclaimAbi = parseAbi([
  'function reclaim((address operator, address payer, address receiver, address token, uint120 maxAmount, uint48 preApprovalExpiry, uint48 authorizationExpiry, uint48 refundExpiry, uint16 minFeeBps, uint16 maxFeeBps, address feeReceiver, uint256 salt) paymentInfo)',
])

/** The payer reclaims `info` from the escrow directly, as anyone's wallet can once it expired; fails if it reverts. */
export const reclaimFromEscrow = async (world: OnChain, payer: PrivateKeyAccount, info: PaymentInfo) => {
  const hash = await world.chain.client.sendRawTransaction({
    serializedTransaction: await payer.signTransaction({
      type: 'eip1559',
      chainId: 5042002,
      to: world.chain.escrow,
      data: encodeFunctionData({ abi: reclaimAbi, functionName: 'reclaim', args: [info] }),
      nonce: await world.chain.client.getTransactionCount({ address: payer.address, blockTag: 'pending' }),
      gas: 300_000n,
      ...(await world.chain.client.estimateFeesPerGas()),
    }),
  })
  const receipt = await world.chain.client.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error('The reclaim reverted')
  return hash
}
