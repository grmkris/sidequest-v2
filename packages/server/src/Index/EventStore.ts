import { NostrEvent } from '@sidequest/nostr'
import { sidequestKinds, standardKinds } from '@sidequest/nostr/vocabulary'
import { AccountRef, GrantScope, type Unavailable } from '@sidequest/protocol'
import { Context, Effect, Layer, Option, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'
import { stored } from '../SignIn/Stored.ts'
import { putListing } from './Listings.ts'
import type { Derived, GrantRow, ProfileRow, RelayListRow, RevocationRow, WalletLinkRow } from './Derived.ts'
import { validateEvent, type Validated } from './Validation.ts'

/** Where an event was first seen: published through the API, or read from a relay. */
export type Source = 'publish' | `relay:${string}`

const Tags = Schema.fromJsonString(NostrEvent.fields.tags)
/** A stored event row as `events` holds it: its tags as JSON. */
export const EventRow = Schema.Struct({ ...NostrEvent.fields, tags: Tags })
const Urls = Schema.fromJsonString(Schema.Array(Schema.String))
const ProfileRecord = Schema.Struct({
  pubkey: Schema.String,
  eventId: Schema.String,
  createdAt: Schema.Int,
  name: Schema.NullOr(Schema.String),
  about: Schema.NullOr(Schema.String),
  picture: Schema.NullOr(Schema.String),
})
const RelayListRecord = Schema.Struct({
  pubkey: Schema.String,
  kind: Schema.Int,
  eventId: Schema.String,
  createdAt: Schema.Int,
  read: Urls,
  write: Urls,
})

const WalletLinkRecord = Schema.Struct({
  eventId: Schema.String,
  account: AccountRef,
  pubkey: Schema.String,
  issuedAt: Schema.Int,
  verification: Schema.Literals(['verified', 'unverified']),
})
const NameRecord = Schema.Struct({
  pubkey: Schema.String,
  name: Schema.NullOr(Schema.String),
  walletVerified: Schema.Literals([0, 1]),
})
const GrantRecord = Schema.Struct({
  eventId: Schema.String,
  operator: Schema.String,
  agent: Schema.String,
  scopes: Schema.fromJsonString(Schema.Array(GrantScope)),
  notBefore: Schema.Int,
  expiresAt: Schema.Int,
  label: Schema.String,
  createdAt: Schema.Int,
  revoked: Schema.Literals([0, 1]),
})

/** How a key is named: its profile's name, and whether a verified link currently holds a wallet for it. */
export interface KeyName {
  readonly pubkey: string
  readonly name: string | null
  readonly walletVerified: boolean
}

/** A grant and whether its operator revoked it, by any revocation the index has seen. */
export interface KnownGrant extends GrantRow {
  readonly revoked: boolean
}

/**
 * What the index knows of one key: its latest profile and relay lists, each when it has seen one; the wallets it is
 * currently linked to, and the links it signed that the index could not verify; the grants it gave, and the unrevoked
 * grants it received. Lists are newest first and bounded by `knownLimits`.
 */
export interface Known {
  readonly profile: Option.Option<ProfileRow>
  readonly relayList: Option.Option<RelayListRow>
  readonly messagingRelays: Option.Option<RelayListRow>
  readonly wallets: ReadonlyArray<WalletLinkRow>
  readonly unverifiedWallets: ReadonlyArray<WalletLinkRow>
  readonly agents: ReadonlyArray<KnownGrant>
  readonly operators: ReadonlyArray<KnownGrant>
}

/** The most of each list `known` answers: enough for any person, bounded against a key that signs thousands. */
export const knownLimits = { wallets: 100, unverifiedWallets: 20, grants: 100 } as const

/**
 * The index's tables on D1: `events` and `event_tags`, the latest-per-key tables derived from them, `profiles`,
 * `relay_lists` and `nostr_listings`, and the identity facts, `wallet_links`, `agent_grants` and `grant_revocations`. D1 runs each statement on its own, so every write here is one idempotent statement and a write cut
 * short is repaired by doing it again: storing an event that is there already still indexes its tags and applies what
 * it derives. A derived row is replaced only by an event that supersedes it (`supersedes`), decided in the statement
 * itself, so the tables come out the same whatever order events arrive in. An identity fact is one row per event,
 * never updated: which link wins a wallet and whether a grant is revoked are decided by the reads, inside each query.
 */
export class EventStore extends Context.Service<
  EventStore,
  {
    /** Stores a valid event: `true` when this call stored it, `false` when it was there already. */
    readonly put: (validated: Validated, source: Source, seenAt: number) => Effect.Effect<boolean, Unavailable>
    readonly find: (id: string) => Effect.Effect<Option.Option<NostrEvent>, Unavailable>
    readonly known: (pubkey: string) => Effect.Effect<Known, Unavailable>
    /** Each of `pubkeys`, once: its profile's name, if it has one, and whether a verified link holds a wallet for it. */
    readonly names: (pubkeys: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<KeyName>, Unavailable>
    /** The key a CAIP-10 account is currently linked to: its winning verified link, if it has one. */
    readonly wallet: (account: string) => Effect.Effect<Option.Option<WalletLinkRow>, Unavailable>
    /** Keys that signed Sidequest events or listings, whose profiles and relay lists the poller asks relays for. */
    readonly authors: (limit: number) => Effect.Effect<ReadonlyArray<string>, Unavailable>
    /**
     * Rebuilds every derived table from `events` alone, as if every stored event had just arrived: profiles, relay
     * lists, listings and the identity facts. `chain_facts` is not among them: it holds no event's content, and is
     * rebuilt by re-reading the chain (the chain log poller from an earlier cursor).
     */
    readonly rebuild: Effect.Effect<void, Unavailable>
  }
>()('Sidequest/Index/EventStore') {}

const writes = (sql: SqlClient.SqlClient) => {
  const insertEvent = ({ event, validation }: Validated, source: Source, seenAt: number) =>
    sql<{ readonly id: string }>`
      INSERT INTO events (id, pubkey, kind, created_at, content, tags, sig, first_seen, source, validation)
      VALUES (${event.id}, ${event.pubkey}, ${event.kind}, ${event.created_at}, ${event.content},
        ${JSON.stringify(event.tags)}, ${event.sig}, ${seenAt}, ${source}, ${validation})
      ON CONFLICT (id) DO NOTHING
      RETURNING id`
  // Every tag with a value, by position, in one statement.
  const indexTags = (event: NostrEvent) => sql`
    INSERT INTO event_tags (event_id, position, name, value)
    SELECT ${event.id}, key, json_extract(value, '$[0]'), json_extract(value, '$[1]')
    FROM json_each(${JSON.stringify(event.tags)}) WHERE json_array_length(value) >= 2
    ON CONFLICT DO NOTHING`
  const profile = (row: ProfileRow) => sql`
    INSERT INTO profiles (pubkey, event_id, created_at, name, about, picture)
    VALUES (${row.pubkey}, ${row.eventId}, ${row.createdAt}, ${row.name}, ${row.about}, ${row.picture})
    ON CONFLICT (pubkey) DO UPDATE SET event_id = excluded.event_id, created_at = excluded.created_at,
      name = excluded.name, about = excluded.about, picture = excluded.picture
    -- Replaced only by an event that supersedes it: later, or as old with a lower id.
    WHERE excluded.created_at > profiles.created_at
      OR (excluded.created_at = profiles.created_at AND excluded.event_id < profiles.event_id)`
  const relayList = (row: RelayListRow) => sql`
    INSERT INTO relay_lists (pubkey, kind, event_id, created_at, read, write)
    VALUES (${row.pubkey}, ${row.kind}, ${row.eventId}, ${row.createdAt}, ${JSON.stringify(row.read)},
      ${JSON.stringify(row.write)})
    ON CONFLICT (pubkey, kind) DO UPDATE SET event_id = excluded.event_id, created_at = excluded.created_at,
      read = excluded.read, write = excluded.write
    -- Replaced only by an event that supersedes it: later, or as old with a lower id.
    WHERE excluded.created_at > relay_lists.created_at
      OR (excluded.created_at = relay_lists.created_at AND excluded.event_id < relay_lists.event_id)`
  const walletLink = (row: WalletLinkRow) => sql`
    INSERT INTO wallet_links (event_id, account, pubkey, issued_at, verification)
    VALUES (${row.eventId}, ${row.account}, ${row.pubkey}, ${row.issuedAt}, ${row.verification})
    ON CONFLICT (event_id) DO NOTHING`
  const grant = (row: GrantRow) => sql`
    INSERT INTO agent_grants (event_id, operator, agent, scopes, not_before, expires_at, label, created_at)
    VALUES (${row.eventId}, ${row.operator}, ${row.agent}, ${JSON.stringify(row.scopes)}, ${row.notBefore},
      ${row.expiresAt}, ${row.label}, ${row.createdAt})
    ON CONFLICT (event_id) DO NOTHING`
  const revocation = (row: RevocationRow) => sql`
    INSERT INTO grant_revocations (event_id, grant_id, pubkey) VALUES (${row.eventId}, ${row.grant}, ${row.pubkey})
    ON CONFLICT (event_id) DO NOTHING`
  const apply = (derived: Derived) => {
    switch (derived.table) {
      case 'profiles':
        return profile(derived.row)
      case 'listings':
        return putListing(sql, derived.row)
      case 'relay_lists':
        return relayList(derived.row)
      case 'wallet_links':
        return walletLink(derived.row)
      case 'agent_grants':
        return grant(derived.row)
      case 'grant_revocations':
        return revocation(derived.row)
    }
  }
  return { insertEvent, indexTags, apply }
}

const reads = (sql: SqlClient.SqlClient) => {
  const event = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: EventRow,
    execute: (id) => sql`SELECT id, pubkey, created_at, kind, tags, content, sig FROM events WHERE id = ${id}`,
  })
  const profile = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: ProfileRecord,
    execute: (pubkey) => sql`
      SELECT pubkey, event_id AS eventId, created_at AS createdAt, name, about, picture
      FROM profiles WHERE pubkey = ${pubkey}`,
  })
  const relayLists = SqlSchema.findAll({
    Request: Schema.String,
    Result: RelayListRecord,
    execute: (pubkey) => sql`
      SELECT pubkey, kind, event_id AS eventId, created_at AS createdAt, read, write
      FROM relay_lists WHERE pubkey = ${pubkey}`,
  })
  const authors = SqlSchema.findAll({
    Request: Schema.Int,
    Result: Schema.Struct({ pubkey: Schema.String }),
    execute: (limit) => sql`
      SELECT pubkey FROM events WHERE validation IN ('sidequest', 'listing')
      GROUP BY pubkey ORDER BY MAX(created_at) DESC LIMIT ${limit}`,
  })
  // Keyset pages of the events that derive something, for a rebuild.
  const derivingPage = SqlSchema.findAll({
    Request: Schema.String,
    Result: EventRow,
    execute: (after) => sql`
      SELECT id, pubkey, created_at, kind, tags, content, sig FROM events
      WHERE (validation IN ('profile', 'relayList', 'messagingRelays', 'listing')
          OR kind IN (${sidequestKinds.walletLink}, ${sidequestKinds.grant}, ${sidequestKinds.revocation}))
        AND id > ${after}
      ORDER BY id LIMIT ${rebuildPage}`,
  })
  return { event, profile, relayLists, authors, derivingPage }
}

/** The identity reads: who holds each wallet, and which grants a key gave and received. */
const identityReads = (sql: SqlClient.SqlClient) => {
  // A key's current wallets: each verified link of the key that no other verified link of its account beats, by the
  // greater `issued_at` or, as recent, the lower event id. Decided here, so it never depends on arrival order.
  const wallets = SqlSchema.findAll({
    Request: Schema.String,
    Result: WalletLinkRecord,
    execute: (pubkey) => sql`
      SELECT event_id AS eventId, account, pubkey, issued_at AS issuedAt, verification FROM wallet_links AS link
      WHERE pubkey = ${pubkey} AND verification = 'verified' AND NOT EXISTS (
        SELECT 1 FROM wallet_links AS rival
        WHERE rival.account = link.account AND rival.verification = 'verified'
          AND (rival.issued_at > link.issued_at
            OR (rival.issued_at = link.issued_at AND rival.event_id < link.event_id)))
      ORDER BY issued_at DESC, event_id LIMIT ${knownLimits.wallets}`,
  })
  const unverifiedWallets = SqlSchema.findAll({
    Request: Schema.String,
    Result: WalletLinkRecord,
    execute: (pubkey) => sql`
      SELECT event_id AS eventId, account, pubkey, issued_at AS issuedAt, verification FROM wallet_links
      WHERE pubkey = ${pubkey} AND verification = 'unverified'
      ORDER BY issued_at DESC, event_id LIMIT ${knownLimits.unverifiedWallets}`,
  })
  // An account's winning verified link, by the same rule.
  const wallet = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: WalletLinkRecord,
    execute: (account) => sql`
      SELECT event_id AS eventId, account, pubkey, issued_at AS issuedAt, verification FROM wallet_links
      WHERE account = ${account} AND verification = 'verified'
      ORDER BY issued_at DESC, event_id LIMIT 1`,
  })
  // Each key asked for, once, with its profile's name and whether one of its verified links currently holds a wallet,
  // by the same rule: the listings' author label, for any keys.
  const names = SqlSchema.findAll({
    Request: Schema.Array(Schema.String),
    Result: NameRecord,
    execute: (pubkeys) => sql`
      SELECT asked.value AS pubkey, p.name AS name,
        EXISTS (
          SELECT 1 FROM wallet_links AS link
          WHERE link.pubkey = asked.value AND link.verification = 'verified' AND NOT EXISTS (
            SELECT 1 FROM wallet_links AS rival
            WHERE rival.account = link.account AND rival.verification = 'verified'
              AND (rival.issued_at > link.issued_at
                OR (rival.issued_at = link.issued_at AND rival.event_id < link.event_id)))
        ) AS walletVerified
      FROM (SELECT DISTINCT value FROM json_each(${JSON.stringify(pubkeys)})) AS asked
      LEFT JOIN profiles AS p ON p.pubkey = asked.value
      ORDER BY asked.value`,
  })
  // A grant is revoked by a revocation naming it that its own operator signed, whichever arrived first.
  const grantsBy = SqlSchema.findAll({
    Request: Schema.String,
    Result: GrantRecord,
    execute: (operator) => sql`
      SELECT event_id AS eventId, operator, agent, scopes, not_before AS notBefore, expires_at AS expiresAt, label,
        created_at AS createdAt,
        EXISTS (SELECT 1 FROM grant_revocations AS r WHERE r.grant_id = g.event_id AND r.pubkey = g.operator) AS revoked
      FROM agent_grants AS g WHERE operator = ${operator}
      ORDER BY created_at DESC, event_id LIMIT ${knownLimits.grants}`,
  })
  const grantsTo = SqlSchema.findAll({
    Request: Schema.String,
    Result: GrantRecord,
    execute: (agent) => sql`
      SELECT event_id AS eventId, operator, agent, scopes, not_before AS notBefore, expires_at AS expiresAt, label,
        created_at AS createdAt, 0 AS revoked
      FROM agent_grants AS g WHERE agent = ${agent}
        AND NOT EXISTS (SELECT 1 FROM grant_revocations AS r WHERE r.grant_id = g.event_id AND r.pubkey = g.operator)
      ORDER BY created_at DESC, event_id LIMIT ${knownLimits.grants}`,
  })
  return { wallets, unverifiedWallets, wallet, names, grantsBy, grantsTo }
}

const rebuildPage = 200

const knownGrant = ({ revoked, ...grant }: typeof GrantRecord.Type): KnownGrant => ({
  ...grant,
  revoked: revoked === 1,
})

const kindOf = (rows: ReadonlyArray<RelayListRow>, kind: number) =>
  Option.fromUndefinedOr(rows.find((row) => row.kind === kind))

/** The index's tables on D1; needs the database's `SqlClient`. */
export const D1EventStore = Layer.effect(
  EventStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const { insertEvent, indexTags, apply } = writes(sql)
    const read = { ...reads(sql), ...identityReads(sql) }
    const rederive = (row: NostrEvent) =>
      validateEvent(row).pipe(
        Effect.flatMap(({ derived }) => Effect.forEach(Option.toArray(derived), apply, { discard: true })),
        // A stored event always validates again; one that no longer would derives nothing.
        Effect.catchTag('EventRefused', () => Effect.void),
      )
    const rebuildFrom = (after: string): Effect.Effect<void, Unavailable> =>
      stored(read.derivingPage(after)).pipe(
        Effect.tap((page) => stored(Effect.forEach(page, rederive, { discard: true }))),
        Effect.flatMap((page) => {
          const last = page.at(-1)
          return page.length < rebuildPage || last === undefined ? Effect.void : rebuildFrom(last.id)
        }),
      )
    return EventStore.of({
      put: Effect.fn('Sidequest.Index.put')(function* (validated, source, seenAt) {
        const inserted = yield* stored(insertEvent(validated, source, seenAt))
        yield* stored(indexTags(validated.event))
        yield* stored(Effect.forEach(Option.toArray(validated.derived), apply, { discard: true }))
        return inserted.length > 0
      }),
      find: Effect.fn('Sidequest.Index.find')(function* (id) {
        return yield* stored(read.event(id))
      }),
      known: Effect.fn('Sidequest.Index.known')(function* (pubkey) {
        const profile = yield* stored(read.profile(pubkey))
        const lists = yield* stored(read.relayLists(pubkey))
        const wallets = yield* stored(read.wallets(pubkey))
        const unverifiedWallets = yield* stored(read.unverifiedWallets(pubkey))
        const agents = yield* stored(read.grantsBy(pubkey))
        const operators = yield* stored(read.grantsTo(pubkey))
        return {
          profile,
          relayList: kindOf(lists, standardKinds.relayList),
          messagingRelays: kindOf(lists, standardKinds.messagingRelays),
          wallets,
          unverifiedWallets,
          agents: agents.map(knownGrant),
          operators: operators.map(knownGrant),
        }
      }),
      names: (pubkeys) =>
        stored(read.names(pubkeys)).pipe(
          Effect.map((rows) =>
            rows.map(({ pubkey, name, walletVerified }) => ({ pubkey, name, walletVerified: walletVerified === 1 })),
          ),
          Effect.withSpan('Sidequest.Index.names'),
        ),
      wallet: Effect.fn('Sidequest.Index.wallet')(function* (account) {
        return yield* stored(read.wallet(account))
      }),
      authors: (limit) =>
        stored(read.authors(limit)).pipe(
          Effect.map((rows) => rows.map(({ pubkey }) => pubkey)),
          Effect.withSpan('Sidequest.Index.authors'),
        ),
      rebuild: Effect.gen(function* () {
        yield* stored(sql`DELETE FROM profiles`)
        yield* stored(sql`DELETE FROM nostr_listings`)
        yield* stored(sql`DELETE FROM relay_lists`)
        yield* stored(sql`DELETE FROM wallet_links`)
        yield* stored(sql`DELETE FROM agent_grants`)
        yield* stored(sql`DELETE FROM grant_revocations`)
        yield* rebuildFrom('')
      }).pipe(Effect.withSpan('Sidequest.Index.rebuild')),
    })
  }),
)
