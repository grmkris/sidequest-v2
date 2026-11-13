import type { EventId, Tag } from './Event.ts'
import type { PublicKey } from './Keys.ts'

/** `["e", <event id>]`: relays index it, so `#e` finds every event about a job, a proposal or a grant. */
export const eventTag = (id: EventId): Tag => ['e', id]

/** `["p", <public key>]`: who the event is for, so `#p` finds what concerns a person. */
export const personTag = (key: PublicKey): Tag => ['p', key]

/** The tag for an optional field, or none. */
export const optionalTag = <A>(value: A | undefined, tag: (value: A) => Tag): ReadonlyArray<Tag> =>
  value === undefined ? [] : [tag(value)]
