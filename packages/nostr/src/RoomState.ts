import type { UnixSeconds } from '@sidequest/protocol'
import { Option, Predicate, Result, Schema } from 'effect'
import type { NostrEvent } from './Event.ts'
import { sidequestKinds } from './Kinds.ts'
import type { PublicKey } from './PublicKey.ts'
import type { RelayUrl } from './RelayList.ts'
import { type RoomBody, type RoomFounding, type RoomMessage, RoomText } from './RoomMessage.ts'
import type { Opened } from './RoomPoll.ts'
import type { RoomId, RoomState, SeenWrap } from './RoomPorts.ts'
import { type Membership, transcriptOf } from './RoomTranscript.ts'
import { verifyEvent } from './Verify.ts'

// How a member's room state changes, as pure functions: what it may send, and what a polling pass adds.

const isText = Schema.is(RoomText)

/** Why `me` may not send `body` into a room with these members, if it may not. */
export const bodyRefusal = (
  me: PublicKey,
  membership: Membership,
  body: RoomBody,
): Option.Option<'notMember' | 'notFounder' | 'founderFixed' | 'badBody'> => {
  if (!membership.members.includes(me)) return Option.some('notMember')
  if (Predicate.isTagged(body, 'Text')) return isText(body.text) ? Option.none() : Option.some('badBody')
  if (Predicate.isTagged(body, 'Proposal')) {
    const event = Result.getSuccess(verifyEvent(body.event))
    const own = Option.exists(event, (valid) => valid.kind === sidequestKinds.proposal && valid.pubkey === me)
    return own ? Option.none() : Option.some('badBody')
  }
  if (!membership.founders.includes(me)) return Option.some('notFounder')
  return membership.founders.includes(body.member) ? Option.some('founderFixed') : Option.none()
}

const sameMessage = (a: RoomMessage, b: RoomMessage) => a.room === b.room && a.id === b.id

/** The state holding `message` (once) and having handled `seen`. */
export const withMessage = (state: RoomState, message: RoomMessage, seen: SeenWrap): RoomState => ({
  ...state,
  messages: state.messages.some((held) => sameMessage(held, message)) ? state.messages : [...state.messages, message],
  seen: [...state.seen, seen],
})

/**
 * Whether a room a wrap named is one `me` is in: it is one of the room's founding members, or a founding member added
 * it. Messages of a room not joined are still kept, so an add that arrives later lets the member read them.
 */
const joinable = (founding: RoomFounding, me: PublicKey, messages: ReadonlyArray<RoomMessage>): boolean =>
  founding.buyer === me ||
  founding.bidder === me ||
  messages.some(
    (message) =>
      message.room === founding.room &&
      Predicate.isTagged(message.act, 'Add') &&
      message.act.member === me &&
      (message.author === founding.buyer || message.author === founding.bidder),
  )

/** What one polling pass leaves: the new state, the rooms joined, and the messages new to their transcripts. */
export interface Ingested {
  readonly state: RoomState
  readonly joined: ReadonlyArray<RoomId>
  readonly fresh: ReadonlyArray<RoomMessage>
}

/** The rooms `messages` name that `me` now belongs to and did not hold before. */
const joinedRooms = (
  held: ReadonlyArray<RoomFounding>,
  candidates: ReadonlyArray<RoomFounding>,
  me: PublicKey,
  messages: ReadonlyArray<RoomMessage>,
): ReadonlyArray<RoomFounding> => {
  const known = new Set(held.map((founding) => founding.room))
  const unique = [...new Map(candidates.map((founding) => [founding.room, founding])).values()]
  return unique.filter((founding) => !known.has(founding.room) && joinable(founding, me, messages))
}

/**
 * A polling pass folded into the state: the room messages that opened (each once), every wrap handled except those
 * the signer deferred, the rooms joined, and the cursors of the relays read completely, at the time the pass started.
 */
export const ingest = (
  state: RoomState,
  me: PublicKey,
  outcomes: ReadonlyArray<readonly [NostrEvent, Opened]>,
  complete: ReadonlyArray<RelayUrl>,
  startedAt: UnixSeconds,
): Ingested => {
  const opened = outcomes.flatMap(([, outcome]) => (Predicate.isTagged(outcome, 'Message') ? [outcome] : []))
  const added = opened
    .map((outcome) => outcome.message)
    .filter((message, index, all) => all.findIndex((other) => sameMessage(other, message)) === index)
    .filter((message) => !state.messages.some((held) => sameMessage(held, message)))
  const messages = [...state.messages, ...added]
  const joined = joinedRooms(
    state.rooms,
    opened.map((outcome) => outcome.founding),
    me,
    messages,
  )
  const rooms = [...state.rooms, ...joined]
  const handled = outcomes.flatMap(([wrap, outcome]) =>
    Predicate.isTagged(outcome, 'Deferred') ? [] : [{ wrap: wrap.id, at: wrap.created_at }],
  )
  const cursors = [
    ...state.cursors.filter((cursor) => !complete.some((relay) => relay === cursor.relay)),
    ...complete.map((relay) => ({ relay, polledAt: startedAt })),
  ]
  const addedIds = new Set(added.map((message) => message.id))
  const fresh = rooms.flatMap((founding) =>
    transcriptOf(founding, messages).messages.filter((message) => addedIds.has(message.id)),
  )
  return {
    state: { rooms, messages, seen: [...state.seen, ...handled], cursors },
    joined: joined.map((founding) => founding.room),
    fresh,
  }
}
