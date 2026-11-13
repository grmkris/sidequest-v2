import { Entropy, type EventTemplate, finalizeEvent, type NostrEvent, publicKeyOf, SecretKey } from '@sidequest/nostr'
import {
  buildSidequestEvent,
  jobRequest,
  messagingRelaysTemplate,
  RelayUrl,
  relayListTemplate,
  standardKinds,
} from '@sidequest/nostr/vocabulary'
import { Duration, Effect, Layer, Schema } from 'effect'
import { defaultTiming, type IndexConfig, idleIndex, IndexSettings } from '../src/Index/IndexConfig.ts'
import { IndexLive } from '../src/Index/IndexLive.ts'
import { localSql } from './LocalSql.ts'

// Signed events for the index's tests, made with fixed keys and fixed signing randomness so failures reproduce, and the
// index on a fresh local D1.

export const keyOf = (hex: string) => Schema.decodeSync(SecretKey)(hex)
export const alice = keyOf('0beebd062ec8735f4243466049d7747ef5d6594ee838de147f8aab842b15e273')
export const bob = keyOf('e108399bd8424357a710b606ae0c13166d853d327e47a6e5e038197346bdbf45')
export const carol = keyOf('3333333333333333333333333333333333333333333333333333333333333333')
export const service = keyOf('4444444444444444444444444444444444444444444444444444444444444444')
const zeros = Schema.decodeSync(Entropy)(new Uint8Array(32))

/** Signs a template as `key`'s owner. */
export const signed = (template: EventTemplate, key: SecretKey = alice): NostrEvent =>
  finalizeEvent(template, key, zeros)

/** A kind-0 profile with this JSON content. */
export const profile = (key: SecretKey, createdAt: number, content: Record<string, unknown>) =>
  signed({ created_at: createdAt, kind: standardKinds.profile, tags: [], content: JSON.stringify(content) }, key)

const urls = (list: ReadonlyArray<string>) => list.map((url) => Schema.decodeSync(RelayUrl)(url))

/** A NIP-65 relay list. */
export const relayList = (
  key: SecretKey,
  createdAt: number,
  lists: { readonly read: ReadonlyArray<string>; readonly write: ReadonlyArray<string> },
) => signed(relayListTemplate({ read: urls(lists.read), write: urls(lists.write) }, createdAt), key)

/** A NIP-17 messaging relay list. */
export const messagingRelays = (key: SecretKey, createdAt: number, relays: ReadonlyArray<string>) =>
  signed(messagingRelaysTemplate(urls(relays), createdAt), key)

/** A Sidequest job request signed at `createdAt`. */
export const request = (key: SecretKey, createdAt: number, title = 'A logo') =>
  signed(
    Effect.runSync(
      buildSidequestEvent(
        jobRequest,
        { title, description: 'Small, warm.', expiresAt: createdAt + 86_400 },
        { createdAt },
      ),
    ),
    key,
  )

export const pubkeyOf = publicKeyOf

/** Relay timing for tests: short waits, so a silent relay fails within the test's time. */
export const testTiming = {
  ...defaultTiming,
  connectTimeout: Duration.seconds(2),
  replyTimeout: Duration.millis(800),
}

/** An index that polls and relays to `relays` (local test relays allowed). */
export const relaying = (relays: ReadonlyArray<string>, overrides: Partial<IndexConfig> = {}): IndexConfig => ({
  ...idleIndex,
  relays,
  policy: 'local',
  timing: testTiming,
  ...overrides,
})

/** The index on a fresh local D1 with `config`; `sqlite` reads the database directly. */
export const indexWorld = (config: IndexConfig = idleIndex) => {
  const { sqlite, layer: sql } = localSql()
  const layer = IndexLive.pipe(Layer.provideMerge(Layer.succeed(IndexSettings, config)), Layer.provideMerge(sql))
  return { sqlite, layer }
}

/** The index's derived tables, in a fixed order, for comparing two databases. */
export const derivedTables = (sqlite: ReturnType<typeof localSql>['sqlite']) => ({
  profiles: sqlite.prepare('SELECT * FROM profiles ORDER BY pubkey').all(),
  relayLists: sqlite.prepare('SELECT * FROM relay_lists ORDER BY pubkey, kind').all(),
})
