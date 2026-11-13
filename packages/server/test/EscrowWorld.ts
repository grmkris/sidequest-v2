import { ChainFact } from '@sidequest/fold'
import type { NostrEvent } from '@sidequest/nostr'
import { type Terms, UsdcOnArcTestnet } from '@sidequest/protocol'
import type { OperatorCall } from '@sidequest/settlement/OperatorCall'
import { termsPaymentOf } from '@sidequest/settlement/Payment'
import { CallReverted } from '@sidequest/settlement/Relayer'
import { chainProfiles } from '@sidequest/settlement/Chains'
import { arcTestnet } from '@sidequest/settlement/SettlementChain'
import { Effect, Option, Schema } from 'effect'
import { type Address, getAddress, type Hex, keccak256, toHex } from 'viem'
import type { EscrowChain } from '../src/Escrow/EscrowChain.ts'
import { digestOf } from './JobWorld.ts'

// The escrow's tests: a settlement chain that is only addresses, and a fake of the relayer that records
// what it was asked to send, keeps each intent in `relayer_intents` as the relayer's store would, and answers with a
// transaction hash, or with the revert a simulation would report.

const arc = UsdcOnArcTestnet.network
const day = 86_400

export const testChain = arcTestnet({
  operator: '0x00000000000000000000000000000000000000a1',
  feeReceiver: '0x00000000000000000000000000000000000000f1',
  arbitrator: '0x00000000000000000000000000000000000a4b17',
})

/** The fake relayer's address. */
export const testRelayer = getAddress('0x00000000000000000000000000000000000000e1')

/** One call the fake relayer was asked to send. */
export interface Sent {
  readonly id: string
  readonly call: OperatorCall
}

interface Database {
  readonly prepare: (sql: string) => { readonly run: (...values: Array<string | number>) => unknown }
}

/**
 * The chain at time `clock.now`, and a relayer that records each call. Like the relayer, it keeps one intent per id:
 * asking again under an id it holds resumes that intent and sends nothing new. `reverts` makes every new call fail
 * its simulation with that reason, before any intent is recorded.
 */
export const fakeChain = (sqlite: Database, clock: { now: number; relayerBalance?: bigint }, reverts?: string) => {
  const sent: Array<Sent> = []
  const held = new Set<string>()
  const chain: EscrowChain = {
    chain: testChain,
    relayer: testRelayer,
    mainnet: false,
    profile: chainProfiles['arc-testnet'],
    lowRelayerBalance: 1_000_000_000_000_000_000n,
    chainTime: Effect.sync(() => clock.now),
    relayerBalance: Effect.sync(() => clock.relayerBalance ?? 10_000_000_000_000_000_000n),
    relay: (id, call) =>
      Effect.suspend(() => {
        if (held.has(id)) return Effect.succeed({ id, transactionHash: keccak256(toHex(id)) })
        if (reverts !== undefined) return Effect.fail(new CallReverted({ function: call.function, reason: reverts }))
        held.add(id)
        sent.push({ id, call })
        sqlite
          .prepare(
            `INSERT INTO relayer_intents (id, signer, nonce, target, data, state) VALUES (?, 'relayer', ?, ?, '0x', 'open')`,
          )
          .run(id, held.size, testChain.operator)
        return Effect.succeed({ id, transactionHash: keccak256(toHex(id)) })
      }),
    repair: Effect.void,
    signRuling: Option.some(() => Effect.succeed<Hex>(`0x${'ab'.repeat(65)}`)),
  }
  return { chain, sent }
}

const ContentJson = Schema.fromJsonString(Schema.Struct({ job: Schema.String, payTo: Schema.String }))

/** The payment that funds `proposal` from `payer`, built as the server builds it, and its `JobFunded` fact at `block`. */
export const fundingOf = async (proposal: NostrEvent, terms: Terms, payer: Address, block = 100) => {
  const { job, payTo } = Schema.decodeUnknownSync(ContentJson)(proposal.content)
  const termsDigest = digestOf(proposal)
  const receiver = getAddress(payTo.slice(payTo.lastIndexOf(':') + 1))
  const payment = await Effect.runPromise(termsPaymentOf({ job, termsDigest, terms }, { payer, receiver }, testChain))
  const fact = Schema.decodeUnknownSync(ChainFact)({
    _tag: 'Funded',
    at: { block, logIndex: 0 },
    paymentHash: payment.hash,
    job,
    termsDigest,
    payer: `${arc}:${payment.info.payer}`,
    receiver: `${arc}:${payment.info.receiver}`,
    asset: terms.asset,
    amount: terms.amount,
    deliveryDeadline: terms.deliveryDeadline,
    reviewWindowSeconds: terms.reviewWindowSeconds,
    disputeWindowSeconds: terms.disputeWindowSeconds,
    arbitrationWindowSeconds: terms.arbitrationWindowSeconds,
    arbitrator: `${arc}:${testChain.arbitrator}`,
    authorizationExpiry: payment.info.authorizationExpiry,
  })
  return { payment, fact }
}

/** A later fact on the payment `paymentHash`: delivered at `time`, rejected at `time`, or settled. */
export const laterFact = (
  paymentHash: string,
  tag: 'Delivered' | 'Rejected' | 'Settled',
  time: number,
  block: number,
) =>
  Schema.decodeUnknownSync(ChainFact)(
    tag === 'Delivered'
      ? {
          _tag: tag,
          at: { block, logIndex: 0 },
          paymentHash,
          deliveryHash: `0x${'de'.repeat(32)}`,
          deliveredAt: time,
          reviewEndsAt: time + day,
        }
      : tag === 'Rejected'
        ? { _tag: tag, at: { block, logIndex: 0 }, paymentHash, rejectedAt: time, arbitrationEndsAt: time + 3 * day }
        : {
            _tag: tag,
            at: { block, logIndex: 0 },
            paymentHash,
            outcome: 'Approved',
            workerShareBps: 10_000,
            capturedAmount: '120000000',
            feeAmount: '6000000',
            refundedAmount: '0',
            settledAt: time,
          },
  )
