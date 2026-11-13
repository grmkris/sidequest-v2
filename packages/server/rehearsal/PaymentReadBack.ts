import { type ChainOutcome, EscrowPaymentStatus } from '@sidequest/protocol'
import { Schema } from 'effect'
import { isHex } from 'viem'
import type { CaseChain } from './Chain.ts'
import { type Evidence, step } from './Evidence.ts'
import { anyone } from './Nostr.ts'
import { bodyOf } from './Surfaces.ts'

// After a case: the stage's own account of the job's payment (`GET /api/index/jobs/:id/payment`), checked against what
// the rehearsal saw and the chain. Every transaction the stage relayed for the case's steps is listed there, the escrow
// and operator are the ones the rehearsal expects, and any transaction the stage sent on its own (the settler's
// refund) is mined and succeeded on chain.

/** The payment status; `operator` optional, since stages before it was added do not name it. */
const ReadBack = Schema.Struct({
  ...EscrowPaymentStatus.fields,
  operator: Schema.optionalKey(EscrowPaymentStatus.fields.operator),
})

interface Reading {
  readonly url: string
  readonly chain: CaseChain
  readonly evidence: Evidence
}

const sameAddress = (left: string, right: string) => left.toLowerCase() === right.toLowerCase()

/** The transactions the case's steps recorded: what the stage answered when it relayed them. */
const relayedBySteps = (evidence: Evidence, label: string) =>
  new Set(
    evidence.steps
      .filter((entry) => entry.case === label && entry.transactionHash !== undefined)
      .map((entry) => entry.transactionHash?.toLowerCase()),
  )

/** Reads the job's payment back from the stage and checks it; records each relayed call and its transaction. */
export const paymentReadBack = async (world: Reading, label: string, job: string, outcome: ChainOutcome) => {
  const status = bodyOf(ReadBack, await anyone(world.url).get(`/api/index/jobs/${job}/payment`), 'payment')
  if (status.stage !== 'Settled' || status.outcome !== outcome)
    throw new Error(`The payment reads ${status.stage} ${status.outcome ?? ''}, not Settled ${outcome}`)
  if (!sameAddress(status.escrow, world.chain.escrow)) throw new Error(`The stage names escrow ${status.escrow}`)
  if (status.operator !== undefined && !sameAddress(status.operator, world.chain.operator))
    throw new Error(`The stage names operator ${status.operator}`)
  const listed = new Map(
    status.relayed.flatMap((call) =>
      call.transactionHash === null ? [] : [[call.transactionHash.toLowerCase(), call] as const],
    ),
  )
  const missing = [...relayedBySteps(world.evidence, label)].filter((hash) => hash !== undefined && !listed.has(hash))
  if (missing.length > 0) throw new Error(`The payment status does not list ${missing.join(', ')}`)
  const ownSteps = relayedBySteps(world.evidence, label)
  for (const [hash, call] of listed) {
    if (ownSteps.has(hash) || !isHex(hash)) continue
    const receipt = await world.chain.client.getTransactionReceipt({ hash })
    if (receipt.status !== 'success') throw new Error(`The stage's ${call.intent} reverted on chain`)
  }
  step(world.evidence, {
    case: label,
    step: `the stage's payment status reads Settled ${outcome} and lists every relayed transaction`,
    detail: {
      operator: status.operator ?? 'not named by this stage',
      relayed: status.relayed
        .map((call) => `${call.intent.split(':')[0] ?? call.intent} ${call.state} ${call.transactionHash ?? 'none'}`)
        .join('; '),
    },
  })
}
