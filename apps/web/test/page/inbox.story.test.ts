import { JobView } from '@sidequest/fold'
import { RoomState } from '@sidequest/nostr/rooms'
import { Effect, Option, Schema } from 'effect'
import { AsyncData } from 'foldkit'
import { Command, given, message, model, story } from 'foldkit/story'
import { describe, expect, test } from 'vitest'
import { makeMarks } from '../../src/Marks.ts'
import { Me, Standing } from '../../src/Me.ts'
import {
  init,
  MarkSeen,
  Message,
  meChanged,
  ReadInbox,
  ReadNames,
  ReadSeen,
  ReadUnread,
  update,
} from '../../src/page/Inbox.ts'
import { type InboxJob, itemsOf } from '../../src/page/InboxItems.ts'
import { Problem } from '../../src/Problem.ts'
import { unreadByJob } from '../../src/RoomKit.ts'
import { bidderKey, buyerKey, foldedJob, now, otherKey, proposalFrom, requestId } from '../Fixtures.ts'
import { moneyJob } from './job/MoneyFixtures.ts'

const meAs = (pubkey: string) =>
  Me.Ready({
    identity: { signerKind: 'nip07', pubkey },
    standing: Standing.Known({ maybeName: Option.none(), wallets: [], agents: [] }),
  })

const asBuyer = (view: JobView): InboxJob => ({ role: 'buyer', view })
const asBidder = (view: JobView): InboxJob => ({ role: 'bidder', view })
const kindsOf = (me: string, jobs: ReadonlyArray<InboxJob>) => itemsOf(me, jobs, []).map((item) => item.kind)

describe('what needs the person', () => {
  test('the proposals that stand on the buyer’s open request, and none that were withdrawn or superseded', () => {
    const view = foldedJob({
      stage: 'proposed',
      proposals: [
        proposalFrom(bidderKey, 'e1', '100'),
        proposalFrom(otherKey, 'e2', '200', { withdrawn: true }),
        proposalFrom(otherKey, 'e3', '300', { superseded: true }),
      ],
    })
    const items = itemsOf(buyerKey, [asBuyer(view)], [])
    expect(items.map(({ kind, key, maybePerson }) => [kind, key, maybePerson])).toEqual([
      ['proposal', `proposal:${'e1'.repeat(32)}`, Option.some(bidderKey)],
    ])
    // The bidder is not told about their own proposal.
    expect(kindsOf(bidderKey, [asBidder(view)])).toEqual([])
  })

  test('the bidder whose proposal the buyer accepted, then funded, is told each in turn', () => {
    const accepted = foldedJob({
      stage: 'accepted',
      proposals: [proposalFrom(bidderKey, 'e1', '100', { accepted: true })],
    })
    expect(kindsOf(bidderKey, [asBidder(accepted)])).toEqual(['accepted'])
    expect(kindsOf(buyerKey, [asBuyer(accepted)])).toEqual([])
    const funded = itemsOf(bidderKey, [asBidder(moneyJob('funded'))], [])
    expect(funded.map(({ kind }) => kind)).toEqual(['funded'])
    expect(Option.isSome(funded[0]?.maybeAt ?? Option.none())).toBe(true)
  })

  test('a delivery waits on the buyer while the review window is open, with its end', () => {
    const delivered = moneyJob('delivered')
    const items = itemsOf(buyerKey, [asBuyer(delivered)], [])
    expect(items.map(({ kind, maybeAt }) => [kind, maybeAt])).toEqual([
      ['delivered', Option.fromNullishOr(delivered.delivery?.reviewEndsAt)],
    ])
    expect(kindsOf(bidderKey, [asBidder(delivered)])).toEqual([])
    const closed = moneyJob('delivered', {
      deadlines: { deliveryOverdue: false, reviewWindowOpen: false, arbitrationOpen: false, reclaimable: false },
    })
    expect(kindsOf(buyerKey, [asBuyer(closed)])).toEqual([])
  })

  test('a dispute concerns both sides; a settled job awaits each side’s review until they wrote it', () => {
    expect(kindsOf(buyerKey, [asBuyer(moneyJob('rejected'))])).toEqual(['rejected'])
    expect(kindsOf(bidderKey, [asBidder(moneyJob('rejected'))])).toEqual(['rejected'])
    expect(kindsOf(otherKey, [asBidder(moneyJob('rejected'))])).toEqual([])
    const released = moneyJob('released')
    expect(kindsOf(buyerKey, [asBuyer(released)])).toEqual(['review'])
    const reviewed = moneyJob('released', {
      reviews: [
        {
          id: 'ab'.repeat(32),
          author: buyerKey,
          createdAt: now,
          content: { job: requestId, subject: bidderKey, rating: 5, text: 'Great.' },
          side: 'payer',
          status: 'counted',
        },
      ],
    })
    expect(kindsOf(buyerKey, [asBuyer(reviewed)])).toEqual([])
    expect(kindsOf(bidderKey, [asBidder(reviewed)])).toEqual(['review'])
  })

  test('unseen room messages count per job, from the browser’s room store and its marks', () => {
    const view = foldedJob()
    expect(
      itemsOf(buyerKey, [asBuyer(view)], [{ job: requestId, count: 3 }]).map(({ kind, count }) => [kind, count]),
    ).toEqual([['messages', 3]])
    const room = 'f1'.repeat(32)
    const roomMessage = (author: string, createdAt: number, act: { readonly _tag: 'Text'; readonly text: string }) => ({
      room,
      id: `${createdAt}`.padStart(64, '0'),
      author,
      createdAt,
      clock: 1,
      act,
      viaGateway: false,
      recipients: [],
    })
    const state = Schema.decodeUnknownSync(RoomState)({
      rooms: [{ room, job: requestId, buyer: buyerKey, bidder: bidderKey }],
      messages: [
        roomMessage(bidderKey, now + 1, { _tag: 'Text', text: 'Seen' }),
        roomMessage(bidderKey, now + 5, { _tag: 'Text', text: 'New' }),
        roomMessage(buyerKey, now + 6, { _tag: 'Text', text: 'Mine' }),
      ],
      seen: [],
      cursors: [],
    })
    expect(unreadByJob(state, buyerKey, { [room]: now + 1 })).toEqual([{ job: requestId, count: 1 }])
    expect(unreadByJob(state, buyerKey, {})).toEqual([{ job: requestId, count: 2 }])
    expect(unreadByJob(state, buyerKey, { [room]: now + 10 })).toEqual([])
  })
})

describe('the inbox page', () => {
  test('renders nothing personal before the signer is known, then reads that key’s inbox', () => {
    const before = init('en', Me.Detecting())
    expect(before.commands).toBeUndefined()
    const known = meChanged(before.model, meAs(buyerKey))
    expect(known.commands?.map((command) => [command.name, command.args])).toEqual([
      [ReadInbox.name, { pubkey: buyerKey }],
      [ReadUnread.name, { pubkey: buyerKey }],
      [ReadSeen.name, { pubkey: buyerKey }],
    ])
    expect(meChanged(known.model, meAs(buyerKey)).commands).toBeUndefined()
  })

  test('shows the jobs read, asks for the names in them, and marks everything shown as read', () => {
    const view = foldedJob({ stage: 'proposed', proposals: [proposalFrom(bidderKey, 'e1', '100')] })
    story(
      update,
      given(init('en', meAs(buyerKey)).model),
      message(Message.SucceededReadInbox({ pubkey: buyerKey, jobs: [asBuyer(view)] })),
      Command.expectExact(ReadNames({ pubkeys: [buyerKey, bidderKey] })),
      Command.resolve(ReadNames, Message.SucceededReadNames({ names: [] })),
      message(Message.CompletedReadSeen({ pubkey: buyerKey, seen: [] })),
      message(Message.ClickedMarkAllRead()),
      Command.expectExact(MarkSeen({ pubkey: buyerKey, keys: [`proposal:${'e1'.repeat(32)}`] })),
      Command.resolve(MarkSeen, Message.CompletedMarkSeen()),
      model((page) => expect(page.seen).toEqual([`proposal:${'e1'.repeat(32)}`])),
    )
  })

  test('an answer for another key is dropped, and a failed read says why', () => {
    const opened = init('en', meAs(buyerKey)).model
    const stale = update(opened, Message.SucceededReadInbox({ pubkey: bidderKey, jobs: [] })).model
    expect(stale.jobs).toEqual(AsyncData.Loading())
    const failed = update(opened, Message.FailedReadInbox({ pubkey: buyerKey, problem: Problem.Unavailable() })).model
    expect(failed.jobs).toEqual(AsyncData.Failure({ error: Problem.Unavailable() }))
  })
})

describe('the browser’s marks', () => {
  test('keep what was seen per key and each room’s newest message, and survive a storage that throws', async () => {
    const items = new Map<string, string>()
    const storage: Storage = {
      get length() {
        return items.size
      },
      clear: () => items.clear(),
      key: (index) => [...items.keys()][index] ?? null,
      getItem: (key) => items.get(key) ?? null,
      setItem: (key, value) => {
        items.set(key, value)
      },
      removeItem: (key) => {
        items.delete(key)
      },
    }
    const marks = makeMarks(() => storage)
    await Effect.runPromise(marks.markSeen(buyerKey, ['a', 'b']))
    await Effect.runPromise(marks.markSeen(buyerKey, ['b', 'c']))
    expect(await Effect.runPromise(marks.seen(buyerKey))).toEqual(['a', 'b', 'c'])
    expect(await Effect.runPromise(marks.seen(bidderKey))).toEqual([])
    await Effect.runPromise(marks.markRoomsRead([{ room: 'r1', at: 10 }]))
    await Effect.runPromise(
      marks.markRoomsRead([
        { room: 'r1', at: 5 },
        { room: 'r2', at: 7 },
      ]),
    )
    expect(await Effect.runPromise(marks.roomsRead)).toEqual({ r1: 10, r2: 7 })
    const broken = makeMarks(() => {
      throw new Error('blocked')
    })
    expect(await Effect.runPromise(broken.seen(buyerKey))).toEqual([])
    await Effect.runPromise(broken.markSeen(buyerKey, ['a']))
  })
})
