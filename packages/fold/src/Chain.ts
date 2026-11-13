import type { EventId } from '@sidequest/nostr'
import type { Bytes32 } from '@sidequest/protocol'
import { Predicate } from 'effect'
import {
  type ChainDelivered,
  type ChainEnding,
  type ChainFact,
  type ChainFunded,
  type ChainRejected,
  comparePositions,
  type LogPosition,
} from './ChainFacts.ts'
import { compareText } from './Events.ts'

/** What the chain says about one job: its funding payment and that payment's later facts. */
export interface JobChain {
  readonly funding: ChainFunded | null
  readonly otherPayments: ReadonlyArray<Bytes32>
  readonly delivery: ChainDelivered | null
  readonly rejection: ChainRejected | null
  readonly ending: ChainEnding | null
}

type Tag = ChainFact['_tag']
type Tagged<T extends Tag> = Extract<ChainFact, { readonly _tag: T }>

const tagged = <T extends Tag>(facts: ReadonlyArray<ChainFact>, tag: T): ReadonlyArray<Tagged<T>> =>
  facts.filter((fact): fact is Tagged<T> => Predicate.isTagged(fact, tag))

/**
 * The earliest fact by log position. Two facts at one position are the same log, so a tie can only come from
 * inconsistent input; it is broken by the facts' JSON, which keeps the choice independent of input order.
 */
const earliest = <A extends { readonly at: LogPosition }>(facts: ReadonlyArray<A>): A | null =>
  facts.toSorted(
    (left, right) => comparePositions(left.at, right.at) || compareText(JSON.stringify(left), JSON.stringify(right)),
  )[0] ?? null

const after =
  (position: LogPosition) =>
  (fact: { readonly at: LogPosition }): boolean =>
    comparePositions(fact.at, position) > 0

const unfunded: JobChain = { funding: null, otherPayments: [], delivery: null, rejection: null, ending: null }

/**
 * The job's chain facts. Its funding is the earliest `JobFunded` naming the job; other payments funded for the same job
 * are listed and otherwise ignored. A delivery counts only after the funding, a rejection only after that delivery, an
 * ending (settlement or reclaim) only after the funding, each the earliest of its kind on the funding's payment.
 */
export const chainOf = (job: EventId, facts: ReadonlyArray<ChainFact>): JobChain => {
  const fundings = tagged(facts, 'Funded').filter((fact) => fact.job === job)
  const funding = earliest(fundings)
  if (funding === null) return unfunded
  const own = facts.filter((fact) => fact.paymentHash === funding.paymentHash).filter(after(funding.at))
  const delivery = earliest(tagged(own, 'Delivered'))
  const rejection = delivery === null ? null : earliest(tagged(own, 'Rejected').filter(after(delivery.at)))
  const ending = earliest<ChainEnding>([...tagged(own, 'Settled'), ...tagged(own, 'Reclaimed')])
  const otherPayments = [...new Set(fundings.map((fact) => fact.paymentHash))]
    .filter((hash) => hash !== funding.paymentHash)
    .toSorted(compareText)
  return { funding, otherPayments, delivery, rejection, ending }
}
