import type { ChainFact, ChainFunded } from '@sidequest/fold'
import type { NetworkRef } from '@sidequest/protocol'
import { fundedPaymentOf, type Payment } from '@sidequest/settlement/Payment'
import type { SettlementChain } from '@sidequest/settlement/SettlementChain'
import { addressOn } from '@sidequest/settlement/Words'
import { Option, Predicate } from 'effect'

/** The payment a funding names, rebuilt from its log (see `fundedPaymentOf`), when its accounts are on `network`. */
export const paymentOfFunding = (funding: ChainFunded, chain: SettlementChain): Option.Option<Payment> => {
  const network: NetworkRef = chain.asset.network
  const payer = addressOn(network, funding.payer)
  const receiver = addressOn(network, funding.receiver)
  const arbitrator = addressOn(network, funding.arbitrator)
  if (payer === undefined || receiver === undefined || arbitrator === undefined) return Option.none()
  return fundedPaymentOf(
    {
      paymentHash: funding.paymentHash,
      job: funding.job,
      termsDigest: funding.termsDigest,
      payer,
      receiver,
      amount: BigInt(funding.amount),
      deliveryDeadline: funding.deliveryDeadline,
      reviewWindow: funding.reviewWindowSeconds,
      disputeWindow: funding.disputeWindowSeconds,
      arbitrationWindow: funding.arbitrationWindowSeconds,
      arbitrator,
      authorizationExpiry: funding.authorizationExpiry,
    },
    chain,
  )
}

type Tag = ChainFact['_tag']
type Tagged<T extends Tag> = Extract<ChainFact, { readonly _tag: T }>

const first = <T extends Tag>(facts: ReadonlyArray<ChainFact>, tag: T): Tagged<T> | undefined =>
  facts.find((fact): fact is Tagged<T> => Predicate.isTagged(fact, tag))

/**
 * A job's money as `ChainFacts.forJob` answers it (fundings earliest first, then the earliest funding's later facts in
 * chain order): the funding the fold uses and that payment's first delivery, rejection and ending.
 */
export const moneyOf = (facts: ReadonlyArray<ChainFact>) => {
  const funding = first(facts, 'Funded')
  const own = facts.filter((fact) => funding !== undefined && fact.paymentHash === funding.paymentHash)
  return {
    funding,
    delivery: first(own, 'Delivered'),
    rejection: first(own, 'Rejected'),
    ending: own.find(
      (fact): fact is Tagged<'Settled' | 'Reclaimed'> =>
        Predicate.isTagged(fact, 'Settled') || Predicate.isTagged(fact, 'Reclaimed'),
    ),
  }
}
