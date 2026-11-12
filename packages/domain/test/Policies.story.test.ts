import { Story } from '@alchemy.run/domain/Story'
import { describe, it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { CurrentActor } from '../src/CurrentActor.context.ts'
import { AcceptProposal, ProposalAccepted, ProposalDeclined } from '../src/Job/AcceptProposal.command.ts'
import { CancelRequest, RequestCancelled } from '../src/Job/CancelRequest.command.ts'
import { RequestExpired } from '../src/Job/ExpireRequest.command.ts'
import { PostRequest } from '../src/Job/PostRequest.command.ts'
import { SubmitProposal } from '../src/Job/SubmitProposal.command.ts'
import { RoomOpened } from '../src/Rooms/OpenRoom.command.ts'
import { RoomOpening, RoomOpeningLive } from '../src/Rooms/RoomOpening.policy.ts'
import { Sidequest, SidequestHandlers } from '../src/Sidequest.model.ts'
import {
  alice,
  at,
  bob,
  bobRoom,
  bobRoomOpened,
  bobV1,
  bobV2,
  carol,
  carolRoom,
  carolV1,
  digestV1,
  engagementRoom,
  iso,
  job,
  jobId,
  memoryStores,
  person,
  posted,
  proposal1,
  proposal2,
  proposal3,
  request,
  story,
  termsV1,
  termsV2,
} from './fixtures.ts'

// At-least-once delivery, made certain: every trigger reaches the real room policy twice, the second time under fresh
// command ids, so only the rooms' own idempotence can keep each room opened once.
const RedeliveredRoomOpening = Layer.effect(
  RoomOpening,
  Effect.gen(function* () {
    const handle = yield* RoomOpening
    return (trigger: Parameters<typeof handle>[0]) => Effect.andThen(handle(trigger), handle(trigger))
  }),
).pipe(Layer.provide(RoomOpeningLive))
const redelivered = Story.make(Sidequest, {
  layer: Layer.mergeAll(SidequestHandlers, RedeliveredRoomOpening).pipe(Layer.provide(memoryStores().layer)),
})

describe('rooms open by themselves', () => {
  it.effect('a negotiation room per bidder at their first proposal, and the engagement room at the award', () =>
    redelivered(
      Story.given(job, posted),
      Story.provide(CurrentActor, person(bob)),
      Story.when(job, new SubmitProposal({ proposal: proposal1, terms: termsV1 })),
      Story.then(job, bobV1),
      Story.then(bobRoom, bobRoomOpened),
      Story.when(job, new SubmitProposal({ proposal: proposal2, previous: 1, terms: termsV2 })),
      Story.then(job, bobV2),
      Story.provide(CurrentActor, person(carol)),
      Story.when(job, new SubmitProposal({ proposal: proposal3, terms: termsV1 })),
      Story.then(job, carolV1),
      Story.then(carolRoom, new RoomOpened({ job: jobId, kind: 'negotiation', members: [alice, carol] })),
      Story.provide(CurrentActor, person(alice)),
      Story.when(job, new AcceptProposal({ bidder: carol, version: 1, termsDigest: digestV1 })),
      Story.then(
        job,
        new ProposalAccepted({
          agreement: {
            job: jobId,
            buyer: alice,
            worker: carol,
            proposal: proposal3,
            version: 1,
            terms: termsV1,
            termsDigest: digestV1,
          },
        }),
      ),
      Story.then(job, new ProposalDeclined({ bidder: bob, version: 2 })),
      Story.then(engagementRoom, new RoomOpened({ job: jobId, kind: 'engagement', members: [alice, carol] })),
      // Each room was opened once, though each trigger arrived twice.
      Story.then(bobRoom),
      Story.then(carolRoom),
      Story.then(engagementRoom),
    ),
  )
})

describe('a request’s expiry', () => {
  it.effect('fires when the request’s expiry comes', () =>
    story(
      Story.provide(CurrentActor, person(alice)),
      Story.when(job, new PostRequest({ ...request, expiresAt: at.requestExpiry })),
      Story.then(job, posted),
      Story.clock(iso(at.requestExpiry - 1)),
      Story.then(job),
      Story.clock(iso(at.requestExpiry)),
      Story.then(job, new RequestExpired()),
    ),
  )

  it.effect('records nothing when it fires after the buyer cancelled', () =>
    story(
      Story.provide(CurrentActor, person(alice)),
      Story.when(job, new PostRequest({ ...request, expiresAt: at.requestExpiry })),
      Story.then(job, posted),
      Story.when(job, new CancelRequest()),
      Story.then(job, new RequestCancelled()),
      Story.clock(iso(at.requestExpiry + 60)),
      Story.then(job),
    ),
  )
})
