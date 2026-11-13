import type { JobView, ProposalView } from '@sidequest/fold'
import type { EventId } from '@sidequest/nostr'
import { deliveryNote, jobAccept, jobProposal, statement } from '@sidequest/nostr/vocabulary'
import { type AccountRef, type Bytes32, type Terms, termsDigest, type UnixSeconds } from '@sidequest/protocol'
import { Effect, Option } from 'effect'
import { Core, type CoreError } from '../Core/Core.ts'
import { heldDelegation, relayDelegatedDelivery } from '../Delegations/DelegatedDelivery.ts'
import { delegateOf } from '../Delegations/Delegations.ts'
import type { Admitted } from '../Grants/GrantGate.ts'
import { acting, publishAs, refusedByCore } from './Acting.ts'
import { howToDelegate, Refused } from './Tools.ts'

// The tools that sign. Each passes the grant gate with its scope, checks what the gateway can know before signing (so
// the agent never signs an event the fold would ignore for a reason it could have seen), signs with the agent's key
// naming its grant, and publishes through the core, whose refusal comes back with its own reason.

/** The job as the index folds it, or `UnknownJob`. */
const jobOf = Effect.fnUntraced(function* (job: EventId) {
  const core = yield* Core
  const found = yield* core.job(job).pipe(Effect.mapError(refusedByCore))
  if (Option.isNone(found)) return yield* new Refused({ reason: 'UnknownJob' })
  return found.value
})

/** A proposal of the job by id, or `UnknownProposal`. */
const proposalOf = (view: JobView, proposal: EventId) =>
  Option.match(Option.fromNullishOr(view.proposals.find(({ id }) => id === proposal)), {
    onNone: () => Effect.fail(new Refused({ reason: 'UnknownProposal' })),
    onSome: Effect.succeed,
  })

/**
 * Whether the fold counts the proposal as the admitted agent's operator's: theirs, or an agent's under their grant. The
 * fold supersedes or withdraws a proposal only by its own bidder, so the gateway signs neither for another's.
 */
const isOperators = (proposal: ProposalView, admitted: Admitted) =>
  (proposal.operator ?? proposal.author) === admitted.operator

/** The operator's verified wallet on `network`: where an agent's proposal asks to be paid. */
export const payToOf = Effect.fnUntraced(function* (admitted: Admitted, network: string) {
  const core = yield* Core
  const person = yield* core.person(admitted.operator).pipe(Effect.mapError(refusedByCore))
  const wallet = Option.flatMap(person, ({ wallets }) =>
    Option.fromNullishOr(wallets.find(({ account }) => account.startsWith(`${network}:`))),
  )
  if (Option.isNone(wallet))
    return yield* new Refused({
      reason: 'NoWalletOnNetwork',
      detail: `Your operator has no verified wallet link on ${network}.`,
    })
  return wallet.value.account
})

export const propose = Effect.fnUntraced(function* (input: {
  readonly job: EventId
  readonly terms: Terms
  readonly validUntil: UnixSeconds
  readonly previous?: EventId
}) {
  const admitted = yield* acting('propose')
  const view = yield* jobOf(input.job)
  if (view.buyer === admitted.operator || view.buyer === admitted.agent)
    return yield* new Refused({ reason: 'OwnRequest', detail: 'Your operator posted this request.' })
  if (input.previous !== undefined) {
    const previous = yield* proposalOf(view, input.previous)
    if (!isOperators(previous, admitted)) return yield* new Refused({ reason: 'NotYourProposal' })
  }
  const payTo: AccountRef = yield* payToOf(admitted, input.terms.network)
  const content = {
    job: input.job,
    buyer: view.buyer,
    terms: input.terms,
    termsDigest: yield* termsDigest(input.terms),
    payTo,
    validUntil: input.validUntil,
    ...(input.previous === undefined ? {} : { previous: input.previous }),
  }
  const signed = yield* publishAs(admitted, jobProposal, content)
  return { job: input.job, proposal: signed.id, payTo, signedBy: signed.signedBy, grant: signed.grant }
})

export const withdrawProposal = Effect.fnUntraced(function* (input: {
  readonly job: EventId
  readonly proposal: EventId
  readonly text: string
}) {
  const admitted = yield* acting('propose')
  const proposal = yield* proposalOf(yield* jobOf(input.job), input.proposal)
  if (!isOperators(proposal, admitted)) return yield* new Refused({ reason: 'NotYourProposal' })
  const content = { job: input.job, about: input.proposal, type: 'withdraw_proposal' as const, text: input.text }
  const signed = yield* publishAs(admitted, statement, content)
  return { job: input.job, statement: signed.id, signedBy: signed.signedBy, grant: signed.grant }
})

export const accept = Effect.fnUntraced(function* (input: { readonly job: EventId; readonly proposal: EventId }) {
  const admitted = yield* acting('accept')
  const view = yield* jobOf(input.job)
  if (view.buyer !== admitted.operator) return yield* new Refused({ reason: 'NotTheBuyer' })
  const proposal = yield* proposalOf(view, input.proposal)
  const content = {
    job: input.job,
    proposal: proposal.id,
    termsDigest: proposal.content.termsDigest,
    worker: proposal.author,
  }
  const signed = yield* publishAs(admitted, jobAccept, content, proposal.content.terms.network)
  const after = yield* jobOf(input.job)
  const shown = after.accepts.find(({ id }) => id === signed.id)
  return {
    job: input.job,
    accept: signed.id,
    signedBy: signed.signedBy,
    grant: signed.grant,
    fold: {
      stage: after.stage,
      fromBuyer: shown?.fromBuyer ?? false,
      matchesProposal: shown?.matchesProposal ?? false,
    },
  }
})

export const deliver = Effect.fnUntraced(function* (
  input: { readonly job: EventId; readonly deliveryHash: Bytes32; readonly url?: string; readonly note?: string },
  coreUrl: string,
) {
  const admitted = yield* acting('deliver')
  const core = yield* Core
  const view = yield* jobOf(input.job)
  const funded = view.proposals.find(({ funded: isFunded }) => isFunded)
  // The worker is the funded proposal's bidder: the operator, when their agent proposed under their grant.
  if (funded === undefined || view.worker !== admitted.operator) return yield* new Refused({ reason: 'NotTheWorker' })
  // The core refuses here when the chain has not funded the job: nothing is signed then.
  const typedData = yield* core.deliveryToSign(input.job, input.deliveryHash).pipe(Effect.mapError(refusedByCore))
  const content = {
    job: input.job,
    buyer: view.buyer,
    deliveryHash: input.deliveryHash,
    ...(input.url === undefined ? {} : { url: input.url }),
    ...(input.note === undefined ? {} : { note: input.note }),
  }
  const delegate = Option.getOrUndefined(delegateOf(admitted.agent))
  if (delegate === undefined) return yield* new Refused({ reason: 'KeyUnavailable' })
  const signed = yield* publishAs(admitted, deliveryNote, content, funded.content.terms.network)
  const published = { job: input.job, note: signed.id, signedBy: signed.signedBy, grant: signed.grant }
  /** The answer when the operator's wallet still has to record the delivery. */
  const awaitingWallet = (held: boolean, refusal?: CoreError) => ({
    ...published,
    onChain: {
      signer: 'operator-wallet' as const,
      typedData,
      submit: `POST ${coreUrl}/api/index/jobs/${input.job}/delivery with { deliveryHash, signature }`,
      explanation:
        'The delivery note is published; the escrow records the delivery only when your operator’s wallet (the ' +
        'proposal’s payTo) signs this typed data and it is submitted. Ask your operator to sign it, or to delegate ' +
        'the delivery to your key (see `delegation.howTo`).',
      delegation: {
        delegate,
        held,
        ...(refusal === undefined ? {} : { refusal: coreRefusalOf(refusal) }),
        howTo: howToDelegate,
      },
    },
  })
  // Under the operator wallet's delegation for this job, the agent's own key records the delivery, unattended.
  const held = yield* heldDelegation(admitted.agent, input.job)
  if (Option.isNone(held)) return awaitingWallet(false)
  const delivery = { deliveryHash: input.deliveryHash, typedData }
  return yield* relayDelegatedDelivery(admitted.agent, input.job, delivery, delegate, held.value).pipe(
    Effect.map(({ transactionHash }) => ({
      ...published,
      onChain: {
        signer: 'agent-delegate' as const,
        delegate,
        delegationExpiry: held.value.expiry,
        transactionHash,
      },
    })),
    Effect.catchTags({
      CoreRefused: (refusal) => Effect.succeed(awaitingWallet(true, refusal)),
      CoreUnavailable: (refusal) => Effect.succeed(awaitingWallet(true, refusal)),
    }),
  )
})

/** A core error as the tool shows it beside an answer: its tag, and its reason and detail where it has them. */
const coreRefusalOf = (error: CoreError) => refusedByCore(error).core ?? { refusal: 'CoreUnavailable' }

/** Whether the agent holds a delegation for the job's delivery, and the delegate address its operator names. */
export const deliveryDelegation = Effect.fnUntraced(function* (input: { readonly job: EventId }) {
  const admitted = yield* acting(null)
  const delegate = Option.getOrUndefined(delegateOf(admitted.agent))
  if (delegate === undefined) return yield* new Refused({ reason: 'KeyUnavailable' })
  const held = yield* heldDelegation(admitted.agent, input.job)
  return {
    job: input.job,
    delegate,
    held: Option.isSome(held),
    expiry: Option.getOrNull(Option.map(held, ({ expiry }) => expiry)),
    howTo: howToDelegate,
  }
})
