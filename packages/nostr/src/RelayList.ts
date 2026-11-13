import type { UnixSeconds } from '@sidequest/protocol'
import { Result, Schema } from 'effect'
import type { EventTemplate, NostrEvent, Tag } from './Event.ts'
import type { PublicKey } from './Keys.ts'
import { standardKinds } from './Kinds.ts'
import { VocabularyRefused } from './SidequestEvent.ts'
import { verifyEvent } from './Verify.ts'

/** A relay's WebSocket URL. */
export const RelayUrl = Schema.String.check(Schema.isPattern(/^wss?:\/\/[^\s/?#]+[^\s]*$/u)).pipe(
  Schema.brand('RelayUrl'),
)
export type RelayUrl = typeof RelayUrl.Type

/** Where someone reads and writes (NIP-65, kind 10002): an unmarked relay is both. */
export interface RelayList {
  readonly pubkey: PublicKey
  readonly read: ReadonlyArray<RelayUrl>
  readonly write: ReadonlyArray<RelayUrl>
}

/** Where someone receives private messages (NIP-17, kind 10050). */
export interface MessagingRelays {
  readonly pubkey: PublicKey
  readonly relays: ReadonlyArray<RelayUrl>
}

const isRelayUrl = Schema.is(RelayUrl)

const ofKind = (input: unknown, kind: number): Result.Result<NostrEvent, VocabularyRefused> =>
  Result.flatMap(
    Result.mapError(verifyEvent(input), () => new VocabularyRefused({ reason: 'invalidEvent' })),
    (event) =>
      event.kind === kind ? Result.succeed(event) : Result.fail(new VocabularyRefused({ reason: 'wrongKind' })),
  )

/** Relays in `name` tags whose marker, if any, is `marker`. Tags with something else than a relay URL are skipped. */
const relaysTagged = (event: NostrEvent, name: string, marker?: string): ReadonlyArray<RelayUrl> =>
  event.tags.flatMap((tag) => {
    const [tagName, url, tagMarker] = tag
    const marked = marker === undefined || tagMarker === undefined || tagMarker === marker
    return tagName === name && marked && isRelayUrl(url) ? [url] : []
  })

/** Reads a verified NIP-65 relay list. */
export const parseRelayList = (input: unknown): Result.Result<RelayList, VocabularyRefused> =>
  Result.map(ofKind(input, standardKinds.relayList), (event) => ({
    pubkey: event.pubkey,
    read: relaysTagged(event, 'r', 'read'),
    write: relaysTagged(event, 'r', 'write'),
  }))

/** Reads a verified NIP-17 messaging relay list. */
export const parseMessagingRelays = (input: unknown): Result.Result<MessagingRelays, VocabularyRefused> =>
  Result.map(ofKind(input, standardKinds.messagingRelays), (event) => ({
    pubkey: event.pubkey,
    relays: relaysTagged(event, 'relay'),
  }))

const relayTag = (url: RelayUrl, read: ReadonlyArray<RelayUrl>, write: ReadonlyArray<RelayUrl>): Tag => {
  if (!write.includes(url)) return ['r', url, 'read']
  return read.includes(url) ? ['r', url] : ['r', url, 'write']
}

/** The kind-10002 event for these read and write relays, marking a relay only when it is not both. */
export const relayListTemplate = (lists: Pick<RelayList, 'read' | 'write'>, createdAt: UnixSeconds): EventTemplate => ({
  created_at: createdAt,
  kind: standardKinds.relayList,
  tags: [...new Set([...lists.read, ...lists.write])].map((url) => relayTag(url, lists.read, lists.write)),
  content: '',
})

/** The kind-10050 event for these messaging relays. */
export const messagingRelaysTemplate = (relays: ReadonlyArray<RelayUrl>, createdAt: UnixSeconds): EventTemplate => ({
  created_at: createdAt,
  kind: standardKinds.messagingRelays,
  tags: relays.map((url) => ['relay', url]),
  content: '',
})
