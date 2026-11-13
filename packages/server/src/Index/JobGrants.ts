import type { GrantFact } from '@sidequest/fold'
import { EventId, type NostrEvent, PublicKey } from '@sidequest/nostr'
import { grantOf } from '@sidequest/nostr/vocabulary'
import { Effect, Option, Schema } from 'effect'
import type { EventStore, KnownGrant } from './EventStore.ts'

const Ids = Schema.Struct({ grant: EventId, operator: PublicKey, agent: PublicKey })

/** A grant row as the fold reads it; a row whose keys do not decode (none the index derived) is left out. */
const factOf = (row: KnownGrant): Option.Option<GrantFact> =>
  Option.map(
    Schema.decodeUnknownOption(Ids)({ grant: row.eventId, operator: row.operator, agent: row.agent }),
    (ids) => ({
      ...ids,
      scopes: row.scopes,
      notBefore: row.notBefore,
      expiresAt: row.expiresAt,
      revoked: row.revoked,
    }),
  )

/**
 * The grants `events` name in `sq-grant`, each once, as the fold reads them, revoked or not. At most one per event,
 * so a read is bounded by the events it was given.
 */
export const grantsNamedBy = (store: EventStore['Service'], events: ReadonlyArray<NostrEvent>) =>
  Effect.map(store.grants([...new Set(events.flatMap((event) => Option.toArray(grantOf(event))))].toSorted()), (rows) =>
    rows.flatMap((row) => Option.toArray(factOf(row))),
  )
