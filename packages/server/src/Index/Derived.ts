import type { NostrEvent } from '@sidequest/nostr'
import type { MessagingRelays, ProfileName, RelayList } from '@sidequest/nostr/vocabulary'
import { Option, Schema } from 'effect'

/** The event a derived row came from, and when its author signed it: what decides which row is the latest. */
export interface Origin {
  readonly pubkey: string
  readonly eventId: string
  readonly createdAt: number
}

/** A key's profile as the index keeps it: a name, an about text and a picture, each only when well formed. */
export interface ProfileRow extends Origin {
  readonly name: string | null
  readonly about: string | null
  readonly picture: string | null
}

/** A key's relay list (10002) or messaging relays (10050, whose relays are all `read`). */
export interface RelayListRow extends Origin {
  readonly kind: number
  readonly read: ReadonlyArray<string>
  readonly write: ReadonlyArray<string>
}

/** What an event derives: a profile or a relay list. */
export type Derived =
  | { readonly table: 'profiles'; readonly row: ProfileRow }
  | { readonly table: 'relay_lists'; readonly row: RelayListRow }

/**
 * Whether `candidate` replaces `current` as a key's latest of a kind: NIP-01's rule for replaceable events, the
 * greatest `created_at`, and of two made in the same second the lowest id. A total order on distinct events, so the
 * latest of any set is the same whatever order the set arrived in.
 */
export const supersedes = (candidate: Origin, current: Origin): boolean =>
  candidate.createdAt > current.createdAt ||
  (candidate.createdAt === current.createdAt && candidate.eventId < current.eventId)

const originOf = (event: NostrEvent): Origin => ({
  pubkey: event.pubkey,
  eventId: event.id,
  createdAt: event.created_at,
})

const About = Schema.String.check(Schema.isMaxLength(2000))
const Picture = Schema.String.check(Schema.isMaxLength(2000), Schema.isPattern(/^https:\/\/[^\s]+$/u))

// Other clients write all sorts into kind 0; only these fields are read, and a malformed one is dropped, not fatal.
const ProfileExtras = Schema.fromJsonString(
  Schema.Struct({ about: Schema.optionalKey(Schema.Unknown), picture: Schema.optionalKey(Schema.Unknown) }),
)

const valueOf = <A>(schema: Schema.Decoder<A>, value: unknown): string | null =>
  Option.getOrNull(Option.map(Schema.decodeUnknownOption(schema)(value), String))

/** The profile row of a kind-0 event `parseProfileName` read: its name (or display name), about text and https picture. */
export const profileOf = (event: NostrEvent, names: ProfileName): Derived => {
  const extras = Option.getOrElse(Schema.decodeUnknownOption(ProfileExtras)(event.content), () => ({}))
  return {
    table: 'profiles',
    row: {
      ...originOf(event),
      name: Option.getOrNull(Option.orElse(names.name, () => names.displayName)),
      about: 'about' in extras ? valueOf(About, extras.about) : null,
      picture: 'picture' in extras ? valueOf(Picture, extras.picture) : null,
    },
  }
}

/** The relay-list row of a NIP-65 list. */
export const relayListOf = (event: NostrEvent, list: RelayList): Derived => ({
  table: 'relay_lists',
  row: { ...originOf(event), kind: event.kind, read: list.read, write: list.write },
})

/** The relay-list row of a NIP-17 messaging relay list: where its author reads private messages. */
export const messagingRelaysOf = (event: NostrEvent, list: MessagingRelays): Derived => ({
  table: 'relay_lists',
  row: { ...originOf(event), kind: event.kind, read: list.relays, write: [] },
})
