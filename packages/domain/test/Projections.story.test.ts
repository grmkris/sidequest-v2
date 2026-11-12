import { Story } from '@alchemy.run/domain/Story'
import { describe, it } from '@effect/vitest'
import { JobId, ListingId } from '@sidequest/protocol'
import { Effect, Option } from 'effect'
import { expect } from 'vitest'
import { CurrentActor } from '../src/CurrentActor.context.ts'
import { Listing } from '../src/Directory/Listing.aggregate.ts'
import { memoryListingStore } from '../src/Directory/ListingStore.ts'
import { ListingPublished, PublishListing } from '../src/Directory/PublishListing.command.ts'
import { ListingUpdated, UpdateListing } from '../src/Directory/UpdateListing.command.ts'
import { ListingWithdrawn, WithdrawListing } from '../src/Directory/WithdrawListing.command.ts'
import { Agent } from '../src/Identity/Agent.aggregate.ts'
import { memoryAgentStore } from '../src/Identity/AgentStore.ts'
import { AgentGranted, GrantAgent } from '../src/Identity/GrantAgent.command.ts'
import { AgentRegistered, RegisterAgent } from '../src/Identity/RegisterAgent.command.ts'
import { GrantRevoked, RevokeGrant } from '../src/Identity/RevokeGrant.command.ts'
import { AcceptProposal } from '../src/Job/AcceptProposal.command.ts'
import { Job } from '../src/Job/Job.aggregate.ts'
import { RequestCancelled } from '../src/Job/CancelRequest.command.ts'
import { RequestExpired } from '../src/Job/ExpireRequest.command.ts'
import { RequestPosted } from '../src/Job/PostRequest.command.ts'
import { JobSettled } from '../src/Job/RecordSettlement.command.ts'
import { ChangeRequested } from '../src/Job/RequestChange.command.ts'
import { PostMessage } from '../src/Rooms/PostMessage.command.ts'
import {
  accepted,
  alice,
  aliceAgent,
  at,
  bob,
  bobRoom,
  bobRoomId,
  bobRoomOpened,
  bobV1,
  bobV2,
  carol,
  deliveredOnChain,
  digestV2,
  funded,
  job,
  jobId,
  memoryStores,
  messageInBobRoom,
  person,
  posted,
  receipt,
  request,
  says,
  storyOver,
} from './fixtures.ts'

const listingId = ListingId.make('listing_01JCXZ4Q6N8M2V7T3R5W9Y0B1E')
const listing = Listing.ref(listingId)
const offer = { title: 'Brand sheets', description: 'One page, print-ready.', tags: ['print'] }
const stillOpen = JobId.make('job_01JCXZ4Q6N8M2V7T3R5W9Y0B1E')
const expired = JobId.make('job_01JCXZ4Q6N8M2V7T3R5W9Y0B1F')
const cancelled = JobId.make('job_01JCXZ4Q6N8M2V7T3R5W9Y0B1G')
const postedByBob = (id: JobId) =>
  new RequestPosted({ request: { id, buyer: bob, ...request, expiresAt: at.requestExpiry } })

describe('the agents projection', () => {
  const agent = Agent.ref(aliceAgent)
  const grant = { scopes: ['discuss' as const], expiresAt: at.grantExpiry }

  it.effect('keeps one row per agent through registration, a grant and revocation', () => {
    const stores = memoryStores()
    return storyOver(stores)(
      Story.provide(CurrentActor, person(alice)),
      Story.when(agent, new RegisterAgent({ name: 'Scout' })),
      Story.then(agent, new AgentRegistered({ operator: alice, name: 'Scout' })),
      Story.when(agent, new GrantAgent({ grant })),
      Story.then(agent, new AgentGranted({ grant })),
      Story.when(agent, new RevokeGrant()),
      Story.then(agent, new GrantRevoked()),
    ).pipe(
      Effect.andThen(stores.agents.get(aliceAgent)),
      Effect.map((row) =>
        expect(row).toEqual(
          Option.some({ id: aliceAgent, operator: alice, name: 'Scout', grant, revoked: true, version: 3 }),
        ),
      ),
    )
  })

  it.effect('shows nothing for an agent it has not seen registered, and ignores an older registration after', () => {
    const store = memoryAgentStore()
    return Effect.gen(function* () {
      yield* store.apply([
        { _tag: 'Granted', id: aliceAgent, grant, version: 2 },
        { _tag: 'Registered', id: aliceAgent, operator: alice, name: 'Scout', version: 1 },
      ])
      expect(yield* store.get(aliceAgent)).toEqual(Option.none())
    })
  })
})

describe('the listings projection', () => {
  it.effect('keeps one search row per listing through publish, update and withdrawal', () => {
    const stores = memoryStores()
    return storyOver(stores)(
      Story.provide(CurrentActor, person(carol)),
      Story.when(listing, new PublishListing(offer)),
      Story.then(listing, new ListingPublished({ owner: carol, ...offer })),
      Story.when(listing, new UpdateListing({ ...offer, title: 'Brand sheets and decks', tags: ['print', 'deck'] })),
      Story.then(listing, new ListingUpdated({ ...offer, title: 'Brand sheets and decks', tags: ['print', 'deck'] })),
      Story.when(listing, new WithdrawListing()),
      Story.then(listing, new ListingWithdrawn()),
    ).pipe(
      Effect.andThen(stores.listings.get(listingId)),
      Effect.map((row) =>
        expect(row).toEqual(
          Option.some({
            id: listingId,
            owner: carol,
            ...offer,
            title: 'Brand sheets and decks',
            tags: ['print', 'deck'],
            state: 'withdrawn',
            version: 3,
          }),
        ),
      ),
    )
  })

  it.effect('ignores a redelivered change older than the row', () => {
    const store = memoryListingStore()
    const published = { _tag: 'Published' as const, id: listingId, owner: carol, ...offer }
    return Effect.gen(function* () {
      yield* store.apply([
        { ...published, version: 1 },
        { _tag: 'Withdrawn', id: listingId, version: 3 },
        { _tag: 'Updated', id: listingId, ...offer, title: 'Stale', tags: [], version: 2 },
        { ...published, version: 1 },
      ])
      expect(yield* store.get(listingId)).toEqual(
        Option.some({ id: listingId, owner: carol, ...offer, state: 'withdrawn', version: 3 }),
      )
    })
  })
})

describe('the open jobs projection', () => {
  it.effect('lists a request while it is open, and drops it once awarded, cancelled or expired', () => {
    const stores = memoryStores()
    return storyOver(stores)(
      Story.given(job, posted, bobV1, bobV2),
      Story.given(Job.ref(stillOpen), postedByBob(stillOpen)),
      Story.given(Job.ref(expired), postedByBob(expired), new RequestExpired()),
      Story.given(Job.ref(cancelled), postedByBob(cancelled), new RequestCancelled()),
      Story.provide(CurrentActor, person(alice)),
      Story.when(job, new AcceptProposal({ bidder: bob, version: 2, termsDigest: digestV2 })),
      Story.then(job, accepted),
    ).pipe(
      Effect.andThen(stores.openJobs.list),
      Effect.map((rows) =>
        expect(rows).toEqual([
          { id: stillOpen, buyer: bob, title: request.title, expiresAt: at.requestExpiry, version: 1 },
        ]),
      ),
    )
  })
})

describe('the inbox projection', () => {
  it.effect('gives each account an item, under a cursor of its own, for every event that concerns it', () => {
    const stores = memoryStores()
    return storyOver(stores)(
      Story.given(bobRoom, bobRoomOpened),
      Story.given(
        job,
        posted,
        bobV1,
        new ChangeRequested({ bidder: bob, version: 1, termsDigest: bobV1.proposal.termsDigest }),
        bobV2,
        accepted,
        funded,
        deliveredOnChain,
        new JobSettled({ buyer: alice, worker: bob, outcome: 'paid', receipts: [receipt('capture')] }),
      ),
      Story.provide(CurrentActor, person(alice)),
      Story.when(bobRoom, new PostMessage({ text: says.ask.text, key: 'alice-1' })),
      Story.then(bobRoom, messageInBobRoom(1, alice, says.ask, 'alice-1')),
    ).pipe(
      Effect.andThen(Effect.all([stores.inbox.list(alice, 0), stores.inbox.list(bob, 0), stores.inbox.list(bob, 5)])),
      Effect.map(([aliceItems, bobItems, bobAfter5]) => {
        const shown = (items: typeof aliceItems) =>
          items.map((item) => ({ cursor: item.cursor, kind: item.kind, job: item.job, room: item.room }))
        expect(shown(aliceItems)).toEqual([
          { cursor: 1, kind: 'proposal_submitted', job: jobId, room: null },
          { cursor: 2, kind: 'proposal_submitted', job: jobId, room: null },
          { cursor: 3, kind: 'funding_recorded', job: jobId, room: null },
          { cursor: 4, kind: 'delivery_recorded', job: jobId, room: null },
          { cursor: 5, kind: 'job_settled', job: jobId, room: null },
        ])
        expect(shown(bobItems)).toEqual([
          { cursor: 1, kind: 'change_requested', job: jobId, room: null },
          { cursor: 2, kind: 'proposal_accepted', job: jobId, room: null },
          { cursor: 3, kind: 'funding_recorded', job: jobId, room: null },
          { cursor: 4, kind: 'delivery_recorded', job: jobId, room: null },
          { cursor: 5, kind: 'job_settled', job: jobId, room: null },
          { cursor: 6, kind: 'message_posted', job: jobId, room: bobRoomId },
        ])
        expect(bobAfter5).toEqual([
          {
            account: bob,
            cursor: 6,
            id: `Room/${bobRoomId}:2`,
            kind: 'message_posted',
            job: jobId,
            room: bobRoomId,
            at: at.start,
          },
        ])
      }),
    )
  })
})
