import { Effect, Option, Predicate, Schema } from 'effect'
import { NostrEvent } from './Event.ts'
import { standardKinds } from './Kinds.ts'
import type { PublicKey } from './PublicKey.ts'
import type { RelayUrl } from './RelayList.ts'
import { foundingIn, type RoomFounding, type RoomMessage, roomMessageOf } from './RoomMessage.ts'
import type { RelayCursor, RelayPort, RelayPortFailure, SeenWrap } from './RoomPorts.ts'
import type { RoomSigner } from './RoomSigner.ts'
import { unwrapGiftWith } from './Unwrap.ts'

// One polling pass over a member's inbox relays (ADR-0004, decision 5): per relay, `REQ` the gift wraps tagged with
// the member's key since the last complete pass minus the look-back, page by page until a page is short or adds
// nothing, then open each wrap not handled before. NIP-59 backdates a wrap's `created_at` by up to two days, so a
// cursor without the look-back misses about half of what arrived since the last pass.

/** How a pass reads: the look-back before the last complete pass, the page size asked for, and the most pages read
 * from one relay in one pass. */
export interface PollLimits {
  readonly lookBackSeconds: number
  readonly pageSize: number
  readonly maxPages: number
}

/** One relay's part of a pass: read to the end, read but cut at `maxPages`, or failed and why. */
export interface RelayPoll {
  readonly relay: RelayUrl
  readonly outcome: 'complete' | 'truncated' | RelayPortFailure['reason']
  readonly fetched: number
  readonly pages: number
}

const decodeEvent = Schema.decodeUnknownOption(NostrEvent)

interface Paging {
  readonly wraps: ReadonlyMap<string, NostrEvent>
  readonly pages: number
}

const oldestOf = (page: ReadonlyArray<NostrEvent>) => Math.min(...page.map((event) => event.created_at))

/** Reads `relay` page by page, each up to the oldest wrap of the one before (inclusive: a second may hold more). */
const readPages = Effect.fnUntraced(function* (
  port: RelayPort,
  relay: RelayUrl,
  me: PublicKey,
  since: Option.Option<number>,
  limits: PollLimits,
) {
  const base = { kinds: [standardKinds.giftWrap], '#p': [me], limit: limits.pageSize }
  const window = Option.match(since, { onNone: () => ({}), onSome: (from) => ({ since: from }) })
  const loop = (
    paging: Paging,
    until: Option.Option<number>,
  ): Effect.Effect<Paging & { readonly cut: boolean }, RelayPortFailure> =>
    Effect.gen(function* () {
      const bound = Option.match(until, { onNone: () => ({}), onSome: (to) => ({ until: to }) })
      const raw = yield* port.query(relay, { ...base, ...window, ...bound })
      const page = raw.flatMap((item) => Option.toArray(decodeEvent(item)))
      const fresh = page.filter((event) => !paging.wraps.has(event.id))
      const next = {
        wraps: new Map([...paging.wraps, ...fresh.map((event) => [event.id, event] as const)]),
        pages: paging.pages + 1,
      }
      if (raw.length < limits.pageSize || fresh.length === 0) return { ...next, cut: false }
      if (next.pages >= limits.maxPages) return { ...next, cut: true }
      return yield* loop(next, Option.some(oldestOf(page)))
    })
  return yield* loop({ wraps: new Map(), pages: 0 }, Option.none())
})

/** One relay's wraps for this pass, and how the reading went; a failure is reported, never raised. */
export const pollRelay = (
  port: RelayPort,
  relay: RelayUrl,
  me: PublicKey,
  maybeCursor: Option.Option<RelayCursor>,
  limits: PollLimits,
) =>
  readPages(
    port,
    relay,
    me,
    Option.map(maybeCursor, (cursor) => Math.max(0, cursor.polledAt - limits.lookBackSeconds)),
    limits,
  ).pipe(
    Effect.map((read) => ({
      wraps: [...read.wraps.values()],
      report: {
        relay,
        outcome: read.cut ? ('truncated' as const) : ('complete' as const),
        fetched: read.wraps.size,
        pages: read.pages,
      },
    })),
    Effect.catch((failure: RelayPortFailure) =>
      Effect.succeed({
        wraps: [],
        report: { relay, outcome: failure.reason, fetched: 0, pages: 0 } satisfies RelayPoll,
      }),
    ),
  )

/** What became of one wrap: a room message (with its room's founding), something else that opened or did not open
 * (handled, never fetched into a room again), or a signer that said no (left for the next pass). */
export type Opened =
  | { readonly _tag: 'Message'; readonly message: RoomMessage; readonly founding: RoomFounding }
  | { readonly _tag: 'Handled' }
  | { readonly _tag: 'Deferred' }

/** Opens one wrap with the member's signer. */
export const openWrap = (signer: RoomSigner, wrap: NostrEvent): Effect.Effect<Opened> =>
  unwrapGiftWith(wrap, signer.publicKey, signer.decrypt).pipe(
    Effect.map(({ rumor, seal }): Opened => {
      const message = Option.all({ message: roomMessageOf(rumor, seal), founding: foundingIn(rumor) })
      return Option.match(message, {
        onNone: () => ({ _tag: 'Handled' }),
        onSome: (found) => ({ _tag: 'Message', ...found }),
      })
    }),
    Effect.catch((error): Effect.Effect<Opened> =>
      Effect.succeed(
        Predicate.isTagged(error, 'RoomSignerRefused') && error.reason !== 'undecryptable'
          ? { _tag: 'Deferred' }
          : { _tag: 'Handled' },
      ),
    ),
  )

/**
 * The wraps still worth remembering: a wrap older than every relay's next look-back can never be fetched again, so it
 * is forgotten. With a relay never read completely, nothing is.
 */
export const prunedSeen = (
  seen: ReadonlyArray<SeenWrap>,
  cursors: ReadonlyArray<RelayCursor>,
  relays: ReadonlyArray<RelayUrl>,
  lookBackSeconds: number,
): ReadonlyArray<SeenWrap> => {
  const polled = relays.map((relay) => cursors.find((cursor) => cursor.relay === relay))
  if (polled.some(Predicate.isUndefined) || polled.length === 0) return seen
  const horizon = Math.min(...polled.map((cursor) => cursor?.polledAt ?? 0)) - lookBackSeconds
  return seen.filter((entry) => entry.at >= horizon)
}
