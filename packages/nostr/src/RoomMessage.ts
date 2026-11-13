import { Digest, UnixSeconds } from '@sidequest/protocol'
import { Match, Option, Result, Schema } from 'effect'
import { EventId, type EventTemplate, NostrEvent, type Tag } from './Event.ts'
import { roomIdOf } from './DerivedIds.ts'
import { sidequestKinds, standardKinds } from './Kinds.ts'
import { PublicKey } from './PublicKey.ts'
import type { Rumor } from './Rumor.ts'
import { verifyEvent } from './Verify.ts'

// A room message on the wire: a NIP-17 chat rumor (kind 14) whose tags say which room it is in, where it stands in the
// room's order, and what it does. Its content is what a person wrote, so an ordinary NIP-17 client shows a room's text
// as a conversation. Nothing here encrypts or sends; `Nip17Rooms.ts` does.

/** The most characters (code points) one text message carries. */
export const maxTextLength = 5000

/** Tag names of a room rumor, beside NIP-17's `p` for each recipient. */
const roomTag = { room: 'sq-room', clock: 'sq-clock', act: 'sq-act', via: 'sq-via' } as const

/**
 * A room: its id and the job and two people it derives from (`roomIdOf`). The buyer and the bidder are its founding
 * members, fixed for its life; anyone holding these four values can check that they belong together.
 */
export const RoomFounding = Schema.Struct({ room: Digest, job: EventId, buyer: PublicKey, bidder: PublicKey })
export type RoomFounding = typeof RoomFounding.Type

/** The founding of the room for a job between its buyer and one bidder. */
export const foundingOf = (job: EventId, buyer: PublicKey, bidder: PublicKey): RoomFounding => ({
  room: roomIdOf(job, buyer, bidder),
  job,
  buyer,
  bidder,
})

/** Text within the limit: at least one character, at most {@link maxTextLength} code points. */
export const RoomText = Schema.String.check(
  Schema.makeFilter((text: string) => text.trim().length > 0 && (text.match(/./gsu) ?? []).length <= maxTextLength, {
    expected: 'roomText',
  }),
)

/**
 * What a message does: say something, add or remove a member (a founding member's alone), or carry a signed proposal
 * the bidder chose to keep private. A text's `text` is absent only where a store chose not to keep it (the gateway).
 */
export const RoomAct = Schema.Union([
  Schema.TaggedStruct('Text', { text: Schema.optionalKey(Schema.String) }),
  Schema.TaggedStruct('Add', { member: PublicKey }),
  Schema.TaggedStruct('Remove', { member: PublicKey }),
  Schema.TaggedStruct('Proposal', { event: NostrEvent }),
])
export type RoomAct = typeof RoomAct.Type

/**
 * One message as a member read it: the rumor's id and author (the seal's signer, checked), the time its author gave,
 * its Lamport clock, what it does, whether a gateway-held agent sent it, whom its author wrapped it for, and the seal
 * it came in, which is what a disclosure hands over.
 */
export const RoomMessage = Schema.Struct({
  room: Digest,
  id: EventId,
  author: PublicKey,
  createdAt: UnixSeconds,
  clock: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2 ** 31 - 1 })),
  act: RoomAct,
  viaGateway: Schema.Boolean,
  recipients: Schema.Array(PublicKey),
  seal: Schema.optionalKey(NostrEvent),
})
export type RoomMessage = typeof RoomMessage.Type

/** What a member asks to send; the room layer adds the clock and the recipients. */
export type RoomBody =
  | { readonly _tag: 'Text'; readonly text: string }
  | { readonly _tag: 'Add'; readonly member: PublicKey }
  | { readonly _tag: 'Remove'; readonly member: PublicKey }
  | { readonly _tag: 'Proposal'; readonly event: NostrEvent }

const actTag = (body: RoomBody): Tag =>
  Match.valueTags(body, {
    Text: (): Tag => [roomTag.act, 'text'],
    Add: ({ member }): Tag => [roomTag.act, 'add', member],
    Remove: ({ member }): Tag => [roomTag.act, 'remove', member],
    Proposal: (): Tag => [roomTag.act, 'proposal'],
  })

const contentOf = (body: RoomBody): string =>
  Match.valueTags(body, {
    Text: ({ text }) => text,
    Add: () => '',
    Remove: () => '',
    Proposal: ({ event }) => JSON.stringify(event),
  })

/** The rumor template of a room message from `author` to `recipients` (every member but the author). */
export const roomTemplate = (input: {
  readonly founding: RoomFounding
  readonly body: RoomBody
  readonly clock: number
  readonly recipients: ReadonlyArray<PublicKey>
  readonly viaGateway: boolean
  readonly createdAt: UnixSeconds
}): EventTemplate => {
  const { founding } = input
  return {
    created_at: input.createdAt,
    kind: standardKinds.chatMessage,
    tags: [
      ...input.recipients.map((recipient): Tag => ['p', recipient]),
      [roomTag.room, founding.room, founding.job, founding.buyer, founding.bidder],
      [roomTag.clock, String(input.clock)],
      actTag(input.body),
      ...(input.viaGateway ? [[roomTag.via, 'gateway']] : []),
    ],
    content: contentOf(input.body),
  }
}

const tagsNamed = (rumor: Rumor, name: string) => rumor.tags.filter((tag) => tag[0] === name)
const single = (rumor: Rumor, name: string): Option.Option<Tag> => {
  const found = tagsNamed(rumor, name)
  return found.length === 1 ? Option.fromNullishOr(found[0]) : Option.none()
}
const decodeFounding = Schema.decodeUnknownOption(RoomFounding)
const decodeKey = Schema.decodeUnknownOption(PublicKey)
const decodeText = Schema.decodeUnknownOption(RoomText)
/** The largest clock a message may carry, so a clock is always a safe 32-bit integer. */
const maxClock = 2 ** 31 - 1
const isClock = (text: string | undefined) =>
  text !== undefined && /^[1-9][0-9]{0,9}$/u.test(text) && Number(text) <= maxClock

/** The founding a rumor names, if its four values derive its id. */
export const foundingIn = (rumor: Rumor): Option.Option<RoomFounding> =>
  Option.flatMap(single(rumor, roomTag.room), ([, room, job, buyer, bidder]) =>
    Option.filter(decodeFounding({ room, job, buyer, bidder }), (founding) => {
      const derived = foundingOf(founding.job, founding.buyer, founding.bidder)
      return derived.room === founding.room
    }),
  )

/** A proposal carried in a room: a verified proposal event by the rumor's own author. */
const proposalIn = (rumor: Rumor): Option.Option<NostrEvent> =>
  Option.filter(
    Result.getSuccess(Result.flatMap(parseJsonResult(rumor.content), verifyEvent)),
    (event) => event.kind === sidequestKinds.proposal && event.pubkey === rumor.pubkey,
  )

const parseJsonResult = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown))

const actIn = (rumor: Rumor): Option.Option<RoomAct> =>
  Option.flatMap(single(rumor, roomTag.act), ([, name, member]) => {
    if (name === 'text') return Option.map(decodeText(rumor.content), (text) => ({ _tag: 'Text' as const, text }))
    if (name === 'add') return Option.map(decodeKey(member), (key) => ({ _tag: 'Add' as const, member: key }))
    if (name === 'remove') return Option.map(decodeKey(member), (key) => ({ _tag: 'Remove' as const, member: key }))
    if (name === 'proposal') return Option.map(proposalIn(rumor), (event) => ({ _tag: 'Proposal' as const, event }))
    return Option.none()
  })

/**
 * The room message a rumor is, if it is one: a chat rumor naming a room whose founding derives its id, with one clock,
 * one act this layer knows, and the seal it came in. Whether its author may speak in the room is the transcript's to
 * say (`RoomTranscript.ts`), not this function's.
 */
export const roomMessageOf = (rumor: Rumor, seal: NostrEvent): Option.Option<RoomMessage> => {
  if (rumor.kind !== standardKinds.chatMessage) return Option.none()
  const clock = Option.filter(single(rumor, roomTag.clock), ([, value]) => isClock(value))
  return Option.map(
    Option.all({ founding: foundingIn(rumor), clock, act: actIn(rumor) }),
    ({ founding, clock: [, value], act }) => ({
      room: founding.room,
      id: rumor.id,
      author: rumor.pubkey,
      createdAt: rumor.created_at,
      clock: Number(value),
      act,
      viaGateway: tagsNamed(rumor, roomTag.via).some((tag) => tag[1] === 'gateway'),
      recipients: [...new Set(rumor.tags.flatMap((tag) => (tag[0] === 'p' ? Option.toArray(decodeKey(tag[1])) : [])))],
      seal,
    }),
  )
}
