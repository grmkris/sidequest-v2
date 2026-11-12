import type * as Domain from '@alchemy.run/domain'
import { Story } from '@alchemy.run/domain/Story'
import { describe, it } from '@effect/vitest'
import { DateTime, Effect } from 'effect'
import { TestClock } from 'effect/testing'
import { expect } from 'vitest'
import type { Actor } from '../src/Actor.ts'
import { AgentRevoked } from '../src/AgentRevoked.rejection.ts'
import { CurrentActor } from '../src/CurrentActor.context.ts'
import { GrantExpired } from '../src/GrantExpired.rejection.ts'
import { ProposalDeclined } from '../src/Job/AcceptProposal.command.ts'
import { BidderJobSummary, noBid } from '../src/Job/BidderJobSummary.view.ts'
import { BuyerJobSummary, unpostedBuyerView } from '../src/Job/BuyerJobSummary.view.ts'
import { RequestCancelled } from '../src/Job/CancelRequest.command.ts'
import { JobSummary } from '../src/Job/JobSummary.view.ts'
import { RulingRecorded } from '../src/Job/RecordRuling.command.ts'
import { JobSettled } from '../src/Job/RecordSettlement.command.ts'
import { RejectionRecorded } from '../src/Job/RecordRejection.command.ts'
import { DeliveryRejected } from '../src/Job/RejectDelivery.command.ts'
import { ChangeRequested } from '../src/Job/RequestChange.command.ts'
import { ReviewLeft } from '../src/Job/LeaveReview.command.ts'
import { DeliverySubmitted } from '../src/Job/SubmitDelivery.command.ts'
import { NotPermitted } from '../src/NotPermitted.rejection.ts'
import { PartyRequired } from '../src/PartyRequired.rejection.ts'
import { RoomMessage, RoomMessages } from '../src/Rooms/RoomMessages.stream.ts'
import {
  accepted,
  agentOf,
  agreement,
  alice,
  aliceAgent,
  artifactHash,
  at,
  bob,
  bobAgent,
  bobRoom,
  bobRoomId,
  bobV1,
  bobV2,
  carol,
  carolRoom,
  carolV1,
  deliveredOnChain,
  digestV1,
  funded,
  history,
  job,
  jobId,
  person,
  posted,
  receipt,
  settlement,
  story,
} from './fixtures.ts'

const delivery = { job: jobId, artifactHash, url: 'https://files.example/logo.zip' }
const reason = 'The favicon set is missing.'
const split = [receipt('capture', '180000000'), receipt('void', '120000000')] as const
const review = { job: jobId, author: alice, subject: bob, rating: 4 }

describe('the job summaries', () => {
  it.effect('show the public the request and its stage, the buyer everything, and each bidder their own bid', () =>
    story(
      Story.given(
        job,
        posted,
        bobV1,
        new ChangeRequested({ bidder: bob, version: 1, termsDigest: digestV1 }),
        bobV2,
        carolV1,
        accepted,
        new ProposalDeclined({ bidder: carol, version: 1 }),
        funded,
        new DeliverySubmitted({ delivery }),
        deliveredOnChain,
        new DeliveryRejected({ reason }),
        new RejectionRecorded({ rejectedAt: at.reviewEnds - 60, arbitrationEndsAt: at.reviewEnds + 777_540 }),
        new RulingRecorded({ workerShareBps: 6000, ruling: 'split' }),
        new JobSettled({ buyer: alice, worker: bob, outcome: 'split', receipts: [...split] }),
        new ReviewLeft({ review }),
      ),
      Story.view(JobSummary, job, (view) => expect(view).toEqual({ request: posted.request, state: 'Settled' })),
      Story.view(BuyerJobSummary, job, (view) =>
        expect(view).toEqual({
          request: posted.request,
          state: 'Settled',
          proposals: [bobV1.proposal, bobV2.proposal, carolV1.proposal],
          changesRequested: [{ bidder: bob, version: 1, termsDigest: digestV1 }],
          agreement,
          funding: receipt('authorize'),
          delivery,
          review: { deliveredAt: at.deliveredOnChain, reviewEndsAt: at.reviewEnds },
          dispute: { reason, arbitrationEndsAt: at.reviewEnds + 777_540, workerShareBps: 6000, ruling: 'split' },
          outcome: 'split',
          settlement: [...split],
          reviews: [review],
        }),
      ),
      Story.view(BidderJobSummary, bobRoom, (view) =>
        expect(view).toEqual({
          job: jobId,
          bidder: bob,
          proposals: [bobV1.proposal, bobV2.proposal],
          changesRequested: [1],
          outcome: 'won',
        }),
      ),
      Story.view(BidderJobSummary, carolRoom, (view) =>
        expect(view).toEqual({
          job: jobId,
          bidder: carol,
          proposals: [carolV1.proposal],
          changesRequested: [],
          outcome: 'lost',
        }),
      ),
    ),
  )

  it.effect('follow an open request to its cancellation, with bids pending and no view for a non-bidder', () =>
    story(
      Story.given(job, posted, bobV1),
      Story.view(JobSummary, job, { state: 'Open' }),
      Story.view(BidderJobSummary, bobRoom, { proposals: [bobV1.proposal], outcome: 'pending' }),
      Story.view(BidderJobSummary, carolRoom, Story.none),
      Story.given(job, new RequestCancelled()),
      Story.view(JobSummary, job, { state: 'Cancelled' }),
      Story.view(BuyerJobSummary, job, { state: 'Cancelled', proposals: [bobV1.proposal] }),
    ),
  )

  it.effect("show the buyer a dispute from the chain's rejection, with the reason whenever it arrives", () =>
    story(
      Story.given(job, ...history.delivered),
      Story.given(
        job,
        new RejectionRecorded({ rejectedAt: at.reviewEnds - 60, arbitrationEndsAt: at.reviewEnds + 777_540 }),
      ),
      Story.view(JobSummary, job, { state: 'Disputed' }),
      Story.view(BuyerJobSummary, job, {
        state: 'Disputed',
        dispute: { reason: null, arbitrationEndsAt: at.reviewEnds + 777_540, workerShareBps: null, ruling: null },
      }),
      Story.given(job, new DeliveryRejected({ reason })),
      Story.view(BuyerJobSummary, job, {
        dispute: { reason, arbitrationEndsAt: at.reviewEnds + 777_540, workerShareBps: null, ruling: null },
      }),
    ),
  )

  it.effect("keep a delivery under review when the buyer gives a reason before the chain's rejection", () =>
    story(
      Story.given(job, ...history.delivered, new DeliveryRejected({ reason })),
      Story.view(JobSummary, job, { state: 'Delivered' }),
      Story.view(BuyerJobSummary, job, {
        state: 'Delivered',
        dispute: { reason, arbitrationEndsAt: null, workerShareBps: null, ruling: null },
      }),
    ),
  )
})

/** A read's `validate`, as an Api judges each read: who asks, the key and its state. */
type Contract<Ref, State, E> = {
  readonly validate?: (request: Domain.Read.Request<Ref>, state: State) => Effect.Effect<void, E, CurrentActor>
}
const judge = <Ref, State, E>(contract: Contract<Ref, State, E>, key: Ref, state: State, actor: Actor) =>
  (contract.validate?.({ mode: 'get', key }, state) ?? Effect.die('the read has no validate')).pipe(
    Effect.provideService(CurrentActor, actor),
  )
const refusal = <Ref, State, E>(contract: Contract<Ref, State, E>, key: Ref, state: State, actor: Actor) =>
  Effect.flip(judge(contract, key, state, actor))

const buyerState = { ...unpostedBuyerView, request: posted.request, state: 'Open' as const }
const bobState = { ...noBid, job: jobId, bidder: bob, proposals: [bobV1.proposal] }
const latest = {
  event: new RoomMessage({ seq: 1, author: alice, text: 'Can you start Monday?', members: [alice, bob] }),
  envelope: {
    id: bobRoomId,
    stream: `RoomMessages/${bobRoomId}`,
    seq: 1,
    at: DateTime.makeUnsafe(at.start * 1000),
    commandId: 'story',
    correlationId: 'story',
  },
}

describe('each read', () => {
  it('lets anyone read the public summary, signed in or not: it judges no reader', () => {
    expect(JobSummary.definition).not.toHaveProperty('validate')
    expect(JobSummary.definition).not.toHaveProperty('middleware')
  })

  it.effect('refuses a private summary to the system and to an agent whose grant is revoked or ended', () =>
    Effect.gen(function* () {
      const read = BuyerJobSummary.definition
      expect(yield* refusal(read, job, buyerState, settlement)).toEqual(new PartyRequired({ system: 'settlement' }))
      expect(yield* refusal(read, job, buyerState, agentOf(alice, aliceAgent, ['accept'], { revoked: true }))).toEqual(
        new AgentRevoked({ agent: aliceAgent }),
      )
      yield* TestClock.setTime(at.grantExpiry * 1000)
      expect(yield* refusal(read, job, buyerState, agentOf(alice, aliceAgent, ['accept']))).toEqual(
        new GrantExpired({ agent: aliceAgent, expiresAt: at.grantExpiry, now: at.grantExpiry }),
      )
    }),
  )

  it.effect('lets only the buyer and their agents read the buyer’s summary', () =>
    Effect.gen(function* () {
      const read = BuyerJobSummary.definition
      yield* judge(read, job, buyerState, person(alice))
      yield* judge(read, job, buyerState, agentOf(alice, aliceAgent, ['accept']))
      expect(yield* refusal(read, job, buyerState, person(bob))).toEqual(
        new NotPermitted({ account: bob, required: 'buyer' }),
      )
      expect(yield* refusal(read, job, null, person(alice))).toEqual(
        new NotPermitted({ account: alice, required: 'buyer' }),
      )
    }),
  )

  it.effect('lets only the bidder and their agents read a bidder’s summary', () =>
    Effect.gen(function* () {
      const read = BidderJobSummary.definition
      yield* judge(read, bobRoom, bobState, agentOf(bob, bobAgent, ['propose']))
      expect(yield* refusal(read, bobRoom, bobState, person(alice))).toEqual(
        new NotPermitted({ account: alice, required: 'bidder' }),
      )
      expect(yield* refusal(read, bobRoom, bobState, person(carol))).toEqual(
        new NotPermitted({ account: carol, required: 'bidder' }),
      )
      expect(yield* refusal(read, carolRoom, null, person(carol))).toEqual(
        new NotPermitted({ account: carol, required: 'bidder' }),
      )
    }),
  )

  it.effect('lets only a room’s members read its messages', () =>
    Effect.gen(function* () {
      const read = RoomMessages.definition
      yield* judge(read, bobRoom, latest, person(alice))
      yield* judge(read, bobRoom, latest, agentOf(bob, bobAgent, ['discuss']))
      expect(yield* refusal(read, bobRoom, latest, person(carol))).toEqual(
        new NotPermitted({ account: carol, required: 'member' }),
      )
      // An empty room shows nothing, so there is nothing to refuse.
      yield* judge(read, bobRoom, null, person(carol))
    }),
  )
})
