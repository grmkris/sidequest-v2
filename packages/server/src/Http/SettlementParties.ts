import { Account } from '@sidequest/domain/Identity/Account.aggregate'
import { Job } from '@sidequest/domain/Job/Job.aggregate'
import { type JobStatus, stageOf } from '@sidequest/domain/Job/JobStatus'
import {
  type AccountId,
  Conflict,
  Forbidden,
  type JobId,
  type NetworkRef,
  NotFound,
  Unprocessable,
} from '@sidequest/protocol'
import { addressOn } from '@sidequest/settlement/Words'
import { Effect, Predicate } from 'effect'
import { isAddress, isAddressEqual } from 'viem'

type Stage = JobStatus['_tag']
type InStage<S extends Stage> = Extract<JobStatus, { readonly _tag: S }>

/** Passes when `account` holds `role` in the agreement. */
const requireParty = (account: AccountId, holder: AccountId, role: 'buyer' | 'worker' | 'party') =>
  account === holder
    ? Effect.void
    : Effect.fail(new Forbidden({ reason: 'NotPermitted', evidence: { account, required: role } }))

/**
 * What the settlement endpoints read of the model: a job's state, from its aggregate, and a party's wallets, from
 * their account. The endpoints judge who may act themselves, against the agreement in that state.
 */
export const settlementParties = Effect.gen(function* () {
  const jobs = yield* Job
  const accounts = yield* Account

  /** The job in one of `stages`; a job never posted is not found, one in another stage is a conflict. */
  const jobIn = <S extends Stage>(job: JobId, stages: ReadonlyArray<S>) =>
    Effect.gen(function* () {
      const state = yield* jobs.state(job)
      if (Predicate.isTagged(state, 'Unposted')) return yield* new NotFound({ reason: 'UnknownJob', evidence: { job } })
      const included = (candidate: JobStatus): candidate is InStage<S> =>
        stages.some((stage) => Predicate.isTagged(candidate, stage))
      if (!included(state))
        return yield* new Conflict({ reason: 'WrongState', evidence: { state: stageOf(state), expected: [...stages] } })
      return state
    })

  /** The account's wallets on `network`, in the order it linked them. */
  const walletsOf = (account: AccountId, network: NetworkRef) =>
    Effect.map(accounts.state(account), (state) =>
      Predicate.isTagged(state, 'Registered')
        ? state.wallets.flatMap((wallet) => {
            const address = addressOn(network, wallet)
            return address === undefined ? [] : [address]
          })
        : [],
    )

  /** The wallet a party pays from or is paid to: `chosen` if it is theirs, else the first they linked. */
  const walletFor = Effect.fnUntraced(function* (account: AccountId, network: NetworkRef, chosen?: string) {
    const wallets = yield* walletsOf(account, network)
    const [first] = wallets
    if (chosen === undefined) {
      if (first === undefined) return yield* new Unprocessable({ reason: 'NoWallet', evidence: { account, network } })
      return first
    }
    const match = wallets.find((wallet) => isAddress(chosen, { strict: false }) && isAddressEqual(wallet, chosen))
    if (match === undefined) return yield* new Unprocessable({ reason: 'NotYourWallet', evidence: { wallet: chosen } })
    return match
  })

  return { jobIn, requireParty, walletFor }
})
