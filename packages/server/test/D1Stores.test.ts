import { it } from '@effect/vitest'
import { ListingStore, memoryListingStore, type ListingChange } from '@sidequest/domain/Directory/ListingStore'
import { InboxStore, memoryInboxStore, type InboxItem } from '@sidequest/domain/Inbox/InboxStore'
import { memoryOpenJobStore, OpenJobStore, type OpenJobChange } from '@sidequest/domain/Job/OpenJobStore'
import { AccountId, JobId, ListingId, RoomId } from '@sidequest/protocol'
import { Effect, Layer, Option, Schema } from 'effect'
import { describe, expect } from 'vitest'
import { D1InboxStore } from '../src/Projections/D1InboxStore.ts'
import { D1ListingStore } from '../src/Projections/D1ListingStore.ts'
import { D1OpenJobStore } from '../src/Projections/D1OpenJobStore.ts'
import { localSql } from './LocalSql.ts'

// Each D1 store against the domain's memory store, the model its port describes: the same changes, in any order,
// redelivered or not, leave both holding the same rows.

const listings = [
  ListingId.make('listing_01JCXZ4Q6N8M2V7T3R5W9Y0B1A'),
  ListingId.make('listing_01JCXZ4Q6N8M2V7T3R5W9Y0B1B'),
] as const
const jobs = [JobId.make('job_01JCXZ4Q6N8M2V7T3R5W9Y0B1A'), JobId.make('job_01JCXZ4Q6N8M2V7T3R5W9Y0B1B')] as const
const accounts = [
  AccountId.make('account_01JCXZ4Q6N8M2V7T3R5W9Y0B1A'),
  AccountId.make('account_01JCXZ4Q6N8M2V7T3R5W9Y0B1B'),
] as const
const room = RoomId.make('room_01JCXZ4Q6N8M2V7T3R5W9Y0B1A_engagement')

const Which = Schema.Literals([0, 1])
const Version = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 6 }))
const Title = Schema.Literals(['Logo design', 'Brand sheet'])

const ListingStep = Schema.Struct({
  kind: Schema.Literals(['Published', 'Updated', 'Withdrawn']),
  which: Which,
  version: Version,
  title: Title,
})
const listingChange = ({ kind, which, version, title }: typeof ListingStep.Type): ListingChange => {
  const id = listings[which]
  if (kind === 'Published') return { _tag: kind, id, owner: accounts[0], title, tags: [title.toLowerCase()], version }
  if (kind === 'Updated') return { _tag: kind, id, title, tags: ['revised', title.toLowerCase()], version }
  return { _tag: kind, id, version }
}

const OpenJobStep = Schema.Struct({ opened: Schema.Boolean, which: Which, version: Version, title: Title })
const openJobChange = ({ opened, which, version, title }: typeof OpenJobStep.Type): OpenJobChange => {
  const id = jobs[which]
  return opened
    ? { _tag: 'Opened', row: { id, buyer: accounts[0], title, expiresAt: 1769904000 + which, version } }
    : { _tag: 'Closed', id, version }
}

const InboxStep = Schema.Struct({
  account: Which,
  event: Schema.Literals([1, 2, 3]),
  cursor: Version,
  withRoom: Schema.Boolean,
})
const inboxItem = ({ account, event, cursor, withRoom }: typeof InboxStep.Type): InboxItem => ({
  account: accounts[account],
  cursor,
  id: `Job/${jobs[0]}:${event}`,
  kind: withRoom ? 'message_posted' : 'proposal_submitted',
  job: jobs[0],
  room: withRoom ? room : null,
  at: 1767225600 + cursor,
})

/** Rows in a fixed order, to compare stores that list in different orders. */
const byId = (rows: ReadonlyArray<{ readonly id: string }>) => rows.toSorted((a, b) => a.id.localeCompare(b.id))
const ordered = (items: ReadonlyArray<InboxItem>) =>
  items.toSorted((a, b) => a.cursor - b.cursor || a.id.localeCompare(b.id))

/** The steps applied one at a time, then all again as one redelivered batch. */
const deliveries = <A>(steps: ReadonlyArray<A>) => [...steps.map((step) => [step]), steps]

describe('D1ListingStore', () => {
  it.effect.prop(
    'holds what the memory store holds after any history of listing changes',
    [Schema.Array(ListingStep)],
    ([steps]) =>
      Effect.gen(function* () {
        const store = yield* ListingStore
        const memory = memoryListingStore()
        for (const batch of deliveries(steps.map(listingChange))) {
          yield* store.apply(batch)
          yield* memory.apply(batch)
        }
        for (const id of listings) expect(yield* store.get(id)).toEqual(yield* memory.get(id))
      }).pipe(Effect.provide(D1ListingStore.pipe(Layer.provide(localSql().layer)))),
  )

  it.effect('keeps a withdrawn listing with its tags, and ignores an older publication of it', () =>
    Effect.gen(function* () {
      const store = yield* ListingStore
      const id = listings[0]
      yield* store.apply([
        { _tag: 'Published', id, owner: accounts[0], title: 'Logo design', tags: ['logo', 'svg'], version: 1 },
        { _tag: 'Withdrawn', id, version: 2 },
        { _tag: 'Published', id, owner: accounts[0], title: 'Logo design', tags: ['logo', 'svg'], version: 1 },
      ])
      expect(yield* store.get(id)).toEqual(
        Option.some({
          id,
          owner: accounts[0],
          title: 'Logo design',
          tags: ['logo', 'svg'],
          state: 'withdrawn',
          version: 2,
        }),
      )
    }).pipe(Effect.provide(D1ListingStore.pipe(Layer.provide(localSql().layer)))),
  )
})

describe('D1OpenJobStore', () => {
  it.effect.prop(
    'lists what the memory store lists after any history of openings and closings',
    [Schema.Array(OpenJobStep)],
    ([steps]) =>
      Effect.gen(function* () {
        const store = yield* OpenJobStore
        const memory = memoryOpenJobStore()
        for (const batch of deliveries(steps.map(openJobChange))) {
          yield* store.apply(batch)
          yield* memory.apply(batch)
        }
        expect(byId(yield* store.list)).toEqual(byId(yield* memory.list))
      }).pipe(Effect.provide(D1OpenJobStore.pipe(Layer.provide(localSql().layer)))),
  )

  it.effect('never reopens a job closed by a newer change', () =>
    Effect.gen(function* () {
      const store = yield* OpenJobStore
      const id = jobs[0]
      const opened = { id, buyer: accounts[0], title: 'Logo design', expiresAt: 1769904000, version: 1 }
      yield* store.apply([
        { _tag: 'Closed', id, version: 3 },
        { _tag: 'Opened', row: opened },
      ])
      expect(yield* store.list).toEqual([])
      yield* store.apply([{ _tag: 'Opened', row: { ...opened, version: 4 } }])
      expect(yield* store.list).toEqual([{ ...opened, version: 4 }])
    }).pipe(Effect.provide(D1OpenJobStore.pipe(Layer.provide(localSql().layer)))),
  )
})

describe('D1InboxStore', () => {
  it.effect.prop(
    'lists what the memory store lists, per account and after every cursor',
    [Schema.Array(InboxStep)],
    ([steps]) =>
      Effect.gen(function* () {
        const store = yield* InboxStore
        const memory = memoryInboxStore()
        for (const batch of deliveries(steps.map(inboxItem))) {
          yield* store.record(batch)
          yield* memory.record(batch)
        }
        for (const account of accounts)
          for (const after of [0, 2, 6])
            expect(ordered(yield* store.list(account, after))).toEqual(ordered(yield* memory.list(account, after)))
      }).pipe(Effect.provide(D1InboxStore.pipe(Layer.provide(localSql().layer)))),
  )
})
