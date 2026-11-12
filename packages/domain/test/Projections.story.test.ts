import { Story } from '@alchemy.run/domain/Story'
import { describe, it } from '@effect/vitest'
import { AccountRef, JobId, ListingId } from '@sidequest/protocol'
import { Effect, Option } from 'effect'
import { expect } from 'vitest'
import { CurrentActor } from '../src/CurrentActor.context.ts'
import { Listing } from '../src/Directory/Listing.aggregate.ts'
import { memoryListingStore } from '../src/Directory/ListingStore.ts'
import { ListingPublished, PublishListing } from '../src/Directory/PublishListing.command.ts'
import { ListingUpdated, UpdateListing } from '../src/Directory/UpdateListing.command.ts'
import { ListingWithdrawn, WithdrawListing } from '../src/Directory/WithdrawListing.command.ts'
import { Account } from '../src/Identity/Account.aggregate.ts'
import { memoryAccountNameStore } from '../src/Identity/AccountNameStore.ts'
import { Agent } from '../src/Identity/Agent.aggregate.ts'
import { memoryAgentStore } from '../src/Identity/AgentStore.ts'
import { AgentGranted, GrantAgent } from '../src/Identity/GrantAgent.command.ts'
import { AccountRegistered, RegisterAccount } from '../src/Identity/RegisterAccount.command.ts'
import { AgentRegistered, RegisterAgent } from '../src/Identity/RegisterAgent.command.ts'
import { AccountRenamed, RenameAccount } from '../src/Identity/RenameAccount.command.ts'
import { GrantRevoked, RevokeGrant } from '../src/Identity/RevokeGrant.command.ts'
import { AcceptProposal, ProposalDeclined } from '../src/Job/AcceptProposal.command.ts'
import { Job } from '../src/Job/Job.aggregate.ts'
import { RequestCancelled } from '../src/Job/CancelRequest.command.ts'
import { RequestExpired } from '../src/Job/ExpireRequest.command.ts'
import { memoryPartyJobStore } from '../src/Job/PartyJobStore.ts'
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
  carolV1,
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

describe('the account names projection', () => {
  const wallet = AccountRef.make('eip155:5042002:0x00000000000000000000000000000000000a11ce')

  it.effect('keeps the name each account goes by through registration and a rename', () => {
    const stores = memoryStores()
    const account = Account.ref(alice)
    return storyOver(stores)(
      Story.provide(CurrentActor, person(alice)),
      Story.when(account, new RegisterAccount({ displayName: '0x0000…a11ce', wallet })),
      Story.then(account, new AccountRegistered({ displayName: '0x0000…a11ce', wallet })),
      Story.when(account, new RenameAccount({ displayName: 'Alice' })),
      Story.then(account, new AccountRenamed({ displayName: 'Alice' })),
    ).pipe(
      Effect.andThen(stores.accountNames.list),
      Effect.map((rows) => expect(rows).toEqual([{ id: alice, displayName: 'Alice', version: 2 }])),
    )
  })

  it.effect('ignores a redelivered name older than the one it holds', () => {
    const store = memoryAccountNameStore()
    return Effect.gen(function* () {
      yield* store.apply([
        { id: alice, displayName: 'Alice', version: 2 },
        { id: alice, displayName: '0x0000…a11ce', version: 1 },
      ])
      expect(yield* store.list).toEqual([{ id: alice, displayName: 'Alice', version: 2 }])
    })
  })
})

describe('the party jobs projection', () => {
  const awarded = [accepted, new ProposalDeclined({ bidder: carol, version: 1 })] as const

  it.effect('lists a job for its buyer and each bidder, follows its stage, and makes the winner its worker', () => {
    const stores = memoryStores()
    return storyOver(stores)(
      Story.given(job, posted, bobV1, carolV1, bobV2),
      Story.given(Job.ref(cancelled), postedByBob(cancelled), new RequestCancelled()),
      Story.provide(CurrentActor, person(alice)),
      Story.when(job, new AcceptProposal({ bidder: bob, version: 2, termsDigest: digestV2 })),
      Story.then(job, ...awarded),
    ).pipe(
      Effect.andThen(
        Effect.all([stores.partyJobs.list(alice), stores.partyJobs.list(bob), stores.partyJobs.list(carol)]),
      ),
      Effect.map(([alices, bobs, carols]) => {
        const ours = { id: jobId, buyer: alice, title: request.title, expiresAt: at.requestExpiry, state: 'Awarded' }
        expect(alices).toEqual([{ ...ours, role: 'buyer' }])
        expect(bobs.toSorted((left, right) => left.id.localeCompare(right.id))).toEqual([
          { ...ours, role: 'worker' },
          {
            id: cancelled,
            buyer: bob,
            title: request.title,
            expiresAt: at.requestExpiry,
            state: 'Cancelled',
            role: 'buyer',
          },
        ])
        expect(carols).toEqual([{ ...ours, role: 'bidder' }])
      }),
    )
  })

  it.effect('ignores an older stage after a newer one, and never turns the worker back into a bidder', () => {
    const store = memoryPartyJobStore()
    const posting = { id: jobId, buyer: alice, title: request.title, expiresAt: at.requestExpiry }
    return Effect.gen(function* () {
      yield* store.apply([
        { _tag: 'Posted', ...posting, version: 1 },
        { _tag: 'Bid', id: jobId, bidder: bob },
        { _tag: 'Awarded', id: jobId, worker: bob, version: 3 },
        { _tag: 'Moved', id: jobId, state: 'Disputed', version: 6 },
        { _tag: 'Moved', id: jobId, state: 'Funded', version: 4 },
        { _tag: 'Bid', id: jobId, bidder: bob },
      ])
      expect(yield* store.list(bob)).toEqual([{ ...posting, state: 'Disputed', role: 'worker' }])
    })
  })
})
