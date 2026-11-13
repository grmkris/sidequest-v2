import { Predicate } from 'effect'
import type { PublicKey } from './PublicKey.ts'
import type { RoomFounding, RoomMessage } from './RoomMessage.ts'

// A room's transcript and its members, as a pure function of the messages a member holds, whatever order they arrived
// in. Relays order events by `created_at` and break ties their own way, and NIP-59 backdates wraps by up to two days,
// so arrival order says nothing; each message carries its own ordering key instead.
//
// The key is a Lamport clock: a member sends `1 + the greatest clock it has seen in the room`. One integer is enough
// to put a reply after what it answers, across authors (a per-author sequence alone orders only one author's
// messages), and it costs nothing to carry, where a list of the ids last seen grows with the room. Concurrent messages
// share a clock; they are ordered by the author's `created_at`, then by rumor id, so every member computes the same
// order. A member who inflates the clock moves only their own messages later; they cannot move anyone else's earlier.

/** The order of a room: clock, then the author's time, then the rumor id. Total over distinct messages. */
export const compareMessages = (a: RoomMessage, b: RoomMessage): number => {
  if (a.clock !== b.clock) return a.clock - b.clock
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
  if (a.id === b.id) return 0
  return a.id < b.id ? -1 : 1
}

/** The clock of the next message a member sends: one more than every clock it holds for the room. */
export const nextClock = (messages: ReadonlyArray<RoomMessage>): number =>
  messages.reduce((greatest, message) => Math.max(greatest, message.clock), 0) + 1

/**
 * Who is in a room: its two founding members, fixed for its life, and the members they added and did not remove since.
 * `version` counts the changes that took effect, so two members holding the same messages hold the same version.
 */
export interface Membership {
  readonly room: RoomFounding['room']
  readonly founders: ReadonlyArray<PublicKey>
  readonly members: ReadonlyArray<PublicKey>
  readonly version: number
}

/** Why a message is not in the transcript: its author was not a member at its place in the order, or it tried to
 * change the membership without the right to. */
export type DropReason = 'notMember' | 'notFounder' | 'founderFixed'

/** A room as one member reads it: its messages in order, what was dropped and why, and its members after the last. */
export interface Transcript {
  readonly founding: RoomFounding
  readonly messages: ReadonlyArray<RoomMessage>
  readonly dropped: ReadonlyArray<{ readonly id: RoomMessage['id']; readonly reason: DropReason }>
  readonly membership: Membership
}

interface Fold {
  readonly members: ReadonlySet<PublicKey>
  readonly version: number
  readonly kept: ReadonlyArray<RoomMessage>
  readonly dropped: Transcript['dropped']
}

/** The members after `message`, or why it may not change them. */
const changed = (
  founders: ReadonlySet<PublicKey>,
  members: ReadonlySet<PublicKey>,
  message: RoomMessage,
): ReadonlySet<PublicKey> | DropReason => {
  const act = message.act
  if (!Predicate.isTagged(act, 'Add') && !Predicate.isTagged(act, 'Remove')) return members
  if (!founders.has(message.author)) return 'notFounder'
  if (founders.has(act.member)) return 'founderFixed'
  const next = new Set(members)
  if (Predicate.isTagged(act, 'Add')) next.add(act.member)
  else next.delete(act.member)
  return next
}

const step =
  (founders: ReadonlySet<PublicKey>) =>
  (fold: Fold, message: RoomMessage): Fold => {
    const drop = (reason: DropReason) => ({ ...fold, dropped: [...fold.dropped, { id: message.id, reason }] })
    if (!fold.members.has(message.author)) return drop('notMember')
    const members = changed(founders, fold.members, message)
    if (typeof members === 'string') return drop(members)
    const effective = members.size !== fold.members.size
    return {
      members,
      version: fold.version + (effective ? 1 : 0),
      kept: [...fold.kept, message],
      dropped: fold.dropped,
    }
  }

/**
 * The transcript of `founding`'s room from the messages held for it (other rooms' are ignored, a message held twice
 * counts once). Walking them in order, a message is kept when its author is a member at that point; an add or a remove
 * also needs a founding member as its author and an added member as its subject. The result depends only on the set
 * of messages, never on the order they came in.
 */
export const transcriptOf = (founding: RoomFounding, messages: ReadonlyArray<RoomMessage>): Transcript => {
  const unique = new Map(messages.filter((message) => message.room === founding.room).map((m) => [m.id, m]))
  const ordered = [...unique.values()].toSorted(compareMessages)
  const founders = new Set([founding.buyer, founding.bidder])
  const folded = ordered.reduce(step(founders), { members: founders, version: 0, kept: [], dropped: [] })
  return {
    founding,
    messages: folded.kept,
    dropped: folded.dropped,
    membership: {
      room: founding.room,
      founders: [founding.buyer, founding.bidder],
      members: [...folded.members].toSorted(),
      version: folded.version,
    },
  }
}
