import { type AccountId, Conflict, type JobId, Unavailable } from '@sidequest/protocol'
import { Effect, Option } from 'effect'
import { Escrow } from '../Settlement/Escrow.ts'
import { settlementParties } from './SettlementParties.ts'
import { settlementRefused } from './SettlementRefusals.ts'

/** The party has not handed over an artifact to sign for, or no agreement is recorded to read. */
export const nothingToSign = (job: JobId) => new Conflict({ reason: 'NothingToSign', evidence: { job } })

/**
 * The chain reader's view of a job's escrow payment, for its buyer or its worker (directly or through an agent): the
 * job must be awarded or later, and the escrow configured. HTTP's `payment` endpoint and MCP's `payment_status` tool
 * both answer with it; it comes with the agreement it is about.
 */
export const paymentStatus = Effect.gen(function* () {
  const configured = yield* Escrow
  const parties = yield* settlementParties
  return Effect.fnUntraced(function* (job: JobId, account: AccountId) {
    const state = yield* parties.jobIn(job, ['Awarded', 'Funded', 'Delivered', 'Disputed', 'Settled'])
    const agreement = state.agreement
    if (agreement === null) return yield* nothingToSign(job)
    if (account !== agreement.worker) yield* parties.requireParty(account, agreement.buyer, 'party')
    if (Option.isNone(configured)) return yield* new Unavailable()
    const status = yield* settlementRefused(configured.value.status(agreement))
    return { agreement, status }
  })
})
