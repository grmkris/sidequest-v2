import { type ChainUnavailable, rpcCall } from '@sidequest/settlement/ChainRpc'
import type { SettlementChain } from '@sidequest/settlement/SettlementChain'
import type { Unavailable } from '@sidequest/protocol'
import { Effect, Option } from 'effect'
import { hexToBigInt, isHex, type PublicClient } from 'viem'
import { type DueCheck, PayPerCall, receiptCheckLimits, type TransferFact, type TxOutcome } from './PayPerCall.ts'

// The chain's side of the x402 rail: for each transaction a receipt names on the settlement chain, the poller asks the
// chain once a minute, until the transaction is confirmed (its ERC-20 transfers recorded) or reverted at the
// confirmation depth, or it gave up asking. It stores what the chain says, never a verdict: whether a receipt is
// verified is the index's read (`receiptVerified`). It is a fact table filled by a poller, not a check at ingest, so
// the index's answer does not depend on when a receipt arrived.

/** ERC-20's `Transfer(address,address,uint256)` topic. */
const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

/** A topic holding an address: its last 20 bytes, in lowercase. */
const addressIn = (topic: string) => `0x${topic.slice(-40).toLowerCase()}`

interface ReceiptLog {
  readonly address: string
  readonly topics: ReadonlyArray<string>
  readonly data: string
  readonly logIndex: string
}

/** An ERC-20 transfer of a receipt's log, if it is one: three topics, the first `Transfer`, and a value. */
const transferOf = (network: string, log: ReceiptLog): Option.Option<TransferFact> => {
  const [topic, from, to] = log.topics
  if (log.topics.length !== 3 || topic !== transferTopic || from === undefined || to === undefined) return Option.none()
  if (!isHex(log.data) || log.data.length !== 66 || !isHex(log.logIndex)) return Option.none()
  return Option.some({
    logIndex: Number(hexToBigInt(log.logIndex)),
    asset: `${network}/erc20:${log.address.toLowerCase()}`,
    from: `${network}:${addressIn(from)}`,
    to: `${network}:${addressIn(to)}`,
    value: hexToBigInt(log.data).toString(),
  })
}

/** What the chain says of one transaction, at `confirmations` blocks below `head`. */
const outcomeOf = Effect.fnUntraced(function* (
  rpc: PublicClient,
  check: DueCheck,
  head: bigint,
  confirmations: number,
): Effect.fn.Return<TxOutcome, ChainUnavailable> {
  if (!isHex(check.txHash)) return { state: 'pending' }
  const hash = check.txHash
  const receipt = yield* rpcCall('eth_getTransactionReceipt', () =>
    rpc.request({ method: 'eth_getTransactionReceipt', params: [hash] }),
  )
  if (receipt === null || !isHex(receipt.blockNumber)) return { state: 'pending' }
  const block = hexToBigInt(receipt.blockNumber)
  if (head - block + 1n < BigInt(Math.max(confirmations, 1))) return { state: 'pending' }
  if (receipt.status !== '0x1') return { state: 'reverted', block: Number(block) }
  const transfers = receipt.logs.flatMap((log) => Option.toArray(transferOf(check.network, log)))
  return { state: 'confirmed', block: Number(block), transfers }
})

/**
 * One pass over the receipts' transactions on `chain` that the chain has not answered for, at most
 * `receiptCheckLimits.perRun` of them. Needs `PayPerCall`.
 */
export const checkReceipts = (
  rpc: PublicClient,
  chain: SettlementChain,
): Effect.Effect<void, ChainUnavailable | Unavailable, PayPerCall> =>
  Effect.gen(function* () {
    const store = yield* PayPerCall
    const due = yield* store.due(chain.asset.network, receiptCheckLimits.perRun)
    if (due.length === 0) return
    const head = yield* rpcCall('eth_blockNumber', () => rpc.getBlockNumber({ cacheTime: 0 }))
    yield* Effect.forEach(
      due,
      (check) =>
        Effect.flatMap(outcomeOf(rpc, check, head, chain.confirmations), (outcome) => store.record(check, outcome)),
      { discard: true },
    )
  }).pipe(Effect.withSpan('Sidequest.Index.checkReceipts', { attributes: { 'sidequest.chain': chain.asset.network } }))
