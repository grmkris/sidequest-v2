import { Context, Effect, Layer, Option, Schema } from 'effect'

// What this browser remembers the person has seen, in `localStorage` only: the inbox's items they marked read (per
// key), and for each room the time of the newest message its panel last showed. No server ever learns either. Every
// access may throw (private windows, blocked site data): a read that fails finds nothing, a write that fails is
// dropped, and the inbox then shows everything as new.

/** At most this many marks are kept of each kind; the oldest go first. */
export const maxMarks = 500

/** One room's newest message the person was shown. */
export interface RoomMark {
  readonly room: string
  readonly at: number
}

export class Marks extends Context.Service<
  Marks,
  {
    /** The inbox items `pubkey`'s person marked read. */
    readonly seen: (pubkey: string) => Effect.Effect<ReadonlyArray<string>>
    readonly markSeen: (pubkey: string, keys: ReadonlyArray<string>) => Effect.Effect<void>
    /** For each room, the time of the newest message its panel showed. */
    readonly roomsRead: Effect.Effect<Readonly<Record<string, number>>>
    readonly markRoomsRead: (marks: ReadonlyArray<RoomMark>) => Effect.Effect<void>
  }
>()('@sidequest/web/Marks') {}

const seenKey = (pubkey: string) => `sidequest.inbox.seen.${pubkey}`
const roomsKey = 'sidequest.rooms.read'

const decodeSeen = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.String)))
const decodeRooms = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Int)))

/** The marks over a storage that may throw at any access. */
export const makeMarks = (storage: () => Storage): Marks['Service'] => {
  const read = (key: string) =>
    Effect.try(() => storage().getItem(key)).pipe(
      Effect.map(Option.fromNullishOr),
      Effect.orElseSucceed(() => Option.none<string>()),
    )
  const write = (key: string, value: string) => Effect.try(() => storage().setItem(key, value)).pipe(Effect.ignore)
  const seen = (pubkey: string) =>
    Effect.map(read(seenKey(pubkey)), (stored) =>
      Option.getOrElse(Option.flatMap(stored, decodeSeen), (): ReadonlyArray<string> => []),
    )
  const roomsRead = Effect.map(read(roomsKey), (stored) =>
    Option.getOrElse(Option.flatMap(stored, decodeRooms), (): Readonly<Record<string, number>> => ({})),
  )
  return Marks.of({
    seen,
    markSeen: (pubkey, keys) =>
      Effect.flatMap(seen(pubkey), (known) =>
        write(seenKey(pubkey), JSON.stringify([...new Set([...known, ...keys])].slice(-maxMarks))),
      ),
    roomsRead,
    markRoomsRead: (marks) =>
      Effect.flatMap(roomsRead, (known) => {
        const merged = { ...known }
        marks.forEach(({ room, at }) => {
          merged[room] = Math.max(merged[room] ?? 0, at)
        })
        const kept = Object.entries(merged)
          .toSorted(([, left], [, right]) => right - left)
          .slice(0, maxMarks)
        return write(roomsKey, JSON.stringify(Object.fromEntries(kept)))
      }),
  })
}

export const marksLayer = (target: Window) =>
  Layer.succeed(
    Marks,
    makeMarks(() => target.localStorage),
  )
