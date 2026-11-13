import { it } from '@effect/vitest'
import { webCrypto } from '@sidequest/protocol'
import { Crypto, Duration, Effect, Result, Schema } from 'effect'
import { TestClock } from 'effect/testing'
import { describe, expect } from 'vitest'
import { EventId } from '../src/Event.ts'
import { freshWrapEntropy, giftWrap } from '../src/GiftWrap.ts'
import type { PublicKey } from '../src/PublicKey.ts'
import type { RelayUrl } from '../src/RelayList.ts'
import { foundingOf, roomTemplate } from '../src/RoomMessage.ts'
import { makeRumor } from '../src/Rumor.ts'
import {
  agentKey,
  atStart,
  bidderKey,
  buyerKey,
  memberOf,
  memoryRelays,
  relayUrl,
  startSeconds,
  strangerKey,
  textsOf,
} from './RoomWorld.ts'

const job = Schema.decodeSync(EventId)('ab'.repeat(32))
const inbox = { buyer: relayUrl('buyer'), bidder: relayUrl('bidder'), agent: relayUrl('agent') }

/** A buyer, a bidder and the bidder's agent over shared memory relays, each with its own inbox relay. */
const world = (pageCap?: number, options = {}) =>
  Effect.gen(function* () {
    yield* atStart
    const network = memoryRelays(pageCap)
    const directory = new Map<PublicKey, ReadonlyArray<RelayUrl>>()
    const buyer = yield* memberOf(network, directory, buyerKey, options)
    const bidder = yield* memberOf(network, directory, bidderKey, options)
    const agent = yield* memberOf(network, directory, agentKey, options)
    directory.set(buyer.pubkey, [inbox.buyer])
    directory.set(bidder.pubkey, [inbox.bidder])
    directory.set(agent.pubkey, [inbox.agent])
    const founding = foundingOf(job, buyer.pubkey, bidder.pubkey)
    yield* buyer.rooms.create(founding)
    yield* bidder.rooms.create(founding)
    return { network, directory, buyer, bidder, agent, founding, room: founding.room }
  })

const say = (text: string) => ({ _tag: 'Text' as const, text })

describe('rooms over NIP-17', () => {
  it.effect('three members, fifty messages, an add and a remove: every member reads the same transcript', () =>
    Effect.gen(function* () {
      const { buyer, bidder, agent, room, network } = yield* world()
      yield* bidder.rooms.add(room, agent.pubkey)
      expect((yield* agent.rooms.poll).joined).toEqual([room])
      const speakers = [buyer, bidder, agent]
      yield* Effect.forEach(
        Array.from({ length: 50 }, (_, index) => index),
        (index) =>
          Effect.gen(function* () {
            const speaker = speakers[index % 3] ?? buyer
            yield* Effect.forEach(speakers, (member) => member.rooms.poll, { discard: true })
            yield* speaker.rooms.send(room, say(`message ${index}`))
            yield* TestClock.adjust(Duration.seconds(7))
          }),
      )
      yield* bidder.rooms.remove(room, agent.pubkey)
      // Removal is by convention: a member wraps for whom it knows to be in the room, so the buyer reads it first.
      yield* buyer.rooms.poll
      yield* buyer.rooms.send(room, say('after the agent left'))
      yield* Effect.forEach(speakers, (member) => member.rooms.poll, { discard: true })
      const [ofBuyer, ofBidder, ofAgent] = yield* Effect.forEach(speakers, (member) => member.rooms.transcript(room))
      expect(textsOf(ofBuyer?.messages ?? [])).toHaveLength(51)
      expect(textsOf(ofBuyer?.messages ?? []).slice(0, 3)).toEqual(['message 0', 'message 1', 'message 2'])
      expect(ofBidder?.messages.map((message) => message.id)).toEqual(ofBuyer?.messages.map((message) => message.id))
      expect(ofBuyer?.membership.members).toEqual([buyer.pubkey, bidder.pubkey].toSorted())
      // The agent read everything up to its removal, and the removal itself; nothing after it was wrapped for it.
      expect(textsOf(ofAgent?.messages ?? [])).toHaveLength(50)
      expect(ofAgent?.membership.members).not.toContain(agent.pubkey)
      const forAgent = [...network.held(inbox.agent).values()]
      expect(forAgent.every((wrap) => wrap.tags.some((tag) => tag[1] === agent.pubkey))).toBe(true)
      expect(yield* Effect.flip(agent.rooms.send(room, say('still here?')))).toMatchObject({ reason: 'notMember' })
    }),
  )

  it.effect('messages sent in the same second come out in one order for everyone, whatever order relays return', () =>
    Effect.gen(function* () {
      const { buyer, bidder, room } = yield* world()
      // Neither has seen the other's message: both send with clock 1, in the same second.
      yield* buyer.rooms.send(room, say('from the buyer'))
      yield* bidder.rooms.send(room, say('from the bidder'))
      yield* buyer.rooms.poll
      yield* bidder.rooms.poll
      yield* buyer.rooms.send(room, say('reply, having seen both'))
      yield* bidder.rooms.poll
      const ofBuyer = yield* buyer.rooms.transcript(room)
      const ofBidder = yield* bidder.rooms.transcript(room)
      expect(ofBuyer.messages.map((message) => message.clock)).toEqual([1, 1, 2])
      expect(textsOf(ofBuyer.messages)).toEqual(textsOf(ofBidder.messages))
      expect(textsOf(ofBuyer.messages)[2]).toBe('reply, having seen both')
    }),
  )

  it.effect('a member away for 48 hours catches up by polling alone, through a relay that caps a page at 100', () =>
    Effect.gen(function* () {
      const { buyer, bidder, room, network } = yield* world(100)
      yield* bidder.rooms.poll
      const sent = yield* Effect.forEach(
        Array.from({ length: 120 }, (_, index) => index),
        (index) =>
          Effect.gen(function* () {
            yield* TestClock.adjust(Duration.minutes(24))
            return yield* buyer.rooms.send(room, say(`while away ${index}`))
          }),
      )
      expect(sent).toHaveLength(120)
      const back = yield* bidder.rooms.poll
      expect(back.relays).toEqual([expect.objectContaining({ outcome: 'complete' })])
      expect(back.relays[0]?.pages).toBeGreaterThan(1)
      expect(textsOf((yield* bidder.rooms.transcript(room)).messages)).toHaveLength(120)
      expect(network.asked.every((filter) => filter.limit === 100)).toBe(true)
    }),
  )

  it.effect('a plain cursor (no look-back) loses backdated wraps: the planted bug', () =>
    Effect.gen(function* () {
      const { buyer, bidder, room } = yield* world(100, { lookBackSeconds: 0 })
      yield* bidder.rooms.poll
      yield* Effect.forEach(
        Array.from({ length: 60 }, (_, index) => index),
        (index) =>
          Effect.gen(function* () {
            yield* TestClock.adjust(Duration.minutes(30))
            yield* buyer.rooms.send(room, say(`backdated ${index}`))
            if (index % 10 === 9) yield* bidder.rooms.poll
          }),
      )
      yield* bidder.rooms.poll
      // Wraps claim times up to two days before they were sent, so a cursor at the last poll skips about half.
      expect(textsOf((yield* bidder.rooms.transcript(room)).messages).length).toBeLessThan(55)
    }),
  )

  it.effect('a message from a non-member is dropped and counted', () =>
    Effect.gen(function* () {
      const { buyer, bidder, founding, room, network } = yield* world()
      const stranger = (yield* memberOf(network, new Map(), strangerKey)).pubkey
      const rumor = makeRumor(
        roomTemplate({
          founding,
          body: say('let me in'),
          clock: 1,
          recipients: [buyer.pubkey, bidder.pubkey],
          viaGateway: false,
          createdAt: startSeconds,
        }),
        stranger,
      )
      const entropy = yield* freshWrapEntropy.pipe(Effect.provideService(Crypto.Crypto, webCrypto))
      const times = { sealCreatedAt: startSeconds, wrapCreatedAt: startSeconds }
      const wrap = Result.getOrThrow(giftWrap(rumor, strangerKey, buyer.pubkey, times, entropy))
      yield* network.port.publish(inbox.buyer, wrap)
      yield* bidder.rooms.send(room, say('hello'))
      yield* buyer.rooms.poll
      const read = yield* buyer.rooms.transcript(room)
      expect(textsOf(read.messages)).toEqual(['hello'])
      expect(read.dropped).toEqual([{ id: rumor.id, reason: 'notMember' }])
    }),
  )

  it.effect('a removed member gets no copy of what is said after the removal', () =>
    Effect.gen(function* () {
      const { buyer, bidder, agent, room, network } = yield* world()
      yield* bidder.rooms.add(room, agent.pubkey)
      yield* buyer.rooms.poll
      yield* bidder.rooms.remove(room, agent.pubkey)
      yield* buyer.rooms.poll
      const before = network.held(inbox.agent).size
      yield* buyer.rooms.send(room, say('private again'))
      yield* bidder.rooms.send(room, say('agreed'))
      expect(network.held(inbox.agent).size).toBe(before)
      expect((yield* buyer.rooms.members(room)).members).not.toContain(agent.pubkey)
      // Only a founding member changes who is in the room, and never the founders themselves.
      expect(yield* Effect.flip(buyer.rooms.remove(room, bidder.pubkey))).toMatchObject({ reason: 'founderFixed' })
    }),
  )

  it.effect('a second device on the same key reads the history, its own messages included', () =>
    Effect.gen(function* () {
      const { buyer, bidder, room, network, directory } = yield* world()
      yield* buyer.rooms.send(room, say('first'))
      yield* bidder.rooms.poll
      yield* bidder.rooms.send(room, say('second'))
      const laptop = yield* memberOf(network, directory, buyerKey)
      const read = yield* laptop.rooms.poll
      expect(read.joined).toEqual([room])
      expect(textsOf((yield* laptop.rooms.transcript(room)).messages)).toEqual(['first', 'second'])
    }),
  )

  it.effect('a relay that is down is reported, and the others are read', () =>
    Effect.gen(function* () {
      const { buyer, bidder, room, network, directory } = yield* world()
      directory.set(bidder.pubkey, [inbox.bidder, relayUrl('down')])
      network.down.add(relayUrl('down'))
      const report = yield* buyer.rooms.send(room, say('to both relays'))
      expect(report.deliveries.filter((delivery) => delivery.recipient === bidder.pubkey)).toEqual([
        { recipient: bidder.pubkey, relay: inbox.bidder, outcome: 'sent' },
        { recipient: bidder.pubkey, relay: relayUrl('down'), outcome: 'unreachable' },
      ])
      const polled = yield* bidder.rooms.poll
      expect(polled.relays.map((relay) => relay.outcome)).toEqual(['complete', 'timeout'])
      expect(textsOf((yield* bidder.rooms.transcript(room)).messages)).toEqual(['to both relays'])
    }),
  )

  it.effect('a polled wrap is not opened twice, even after the member reopens from its store', () =>
    Effect.gen(function* () {
      const { buyer, bidder, room } = yield* world()
      yield* buyer.rooms.send(room, say('once'))
      expect((yield* bidder.rooms.poll).opened).toBe(1)
      const reopened = yield* bidder.reopen
      const again = yield* reopened.poll
      expect([again.fresh, again.opened, again.unopenable]).toEqual([[], 0, 0])
    }),
  )
})
