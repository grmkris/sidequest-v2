import { PublicKey } from '@sidequest/nostr'
import { HiddenTarget, labelsHeader, type Unavailable } from '@sidequest/protocol'
import { stored } from '@sidequest/serving/Stored'
import { Context, Effect, Layer, Option, Schema } from 'effect'
import * as HttpEffect from 'effect/http/HttpEffect'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'
import type { Fragment } from 'effect/sql/Statement'
import { nowSeconds } from './Ingest.ts'

/** Who moderates this stage's index: the Nostr key (`SIDEQUEST_MODERATOR_PUBKEY`, 64 hex) whose NIP-98 alone may. */
export interface ModerationConfig {
  readonly moderatorPubkey: Option.Option<PublicKey>
}

/** The stage's moderation settings; unset, nobody may change the hide list. */
export const ModerationSettings = Context.Reference<ModerationConfig>('Sidequest/Index/ModerationSettings', {
  defaultValue: () => ({ moderatorPubkey: Option.none() }),
})

/** The settings from a Worker's variables. A malformed key reads as none; the deploy refused it already. */
export const moderationSettingsFrom = (environment: Readonly<Record<string, unknown>>): ModerationConfig => ({
  moderatorPubkey: Schema.decodeUnknownOption(PublicKey)(environment['SIDEQUEST_MODERATOR_PUBKEY']),
})

/** The most entries the public hide list answers with, newest first. */
export const hiddenListLimit = 500

/**
 * A condition that holds when none of `columns` (event ids or public keys) is on the hide list. The hide list's
 * primary key makes each probe an index search.
 */
export const notHidden = (sql: SqlClient.SqlClient, ...columns: ReadonlyArray<Fragment>) =>
  sql`NOT EXISTS (SELECT 1 FROM hidden_targets WHERE target IN (${sql.join(', ', false)(columns)}))`

/** Marks the response to a read by id as hidden, when the hide list covers what it answers. */
export const labelled = (hidden: boolean) =>
  hidden
    ? HttpEffect.appendPreResponseHandler((_, response) =>
        Effect.succeed(HttpServerResponse.setHeader(response, labelsHeader, 'hidden')),
      )
    : Effect.void

/**
 * The index's hide list: event ids and public keys a stage's moderator took out of the index's lists. The lists
 * (`Listings.search`, `Jobs.open`) leave them out in SQL with `notHidden`; reads by id still answer, labelled
 * (`labelled`). Nothing is deleted, and a hide can be undone. Needs the database's `SqlClient`.
 */
export class Moderation extends Context.Service<
  Moderation,
  {
    readonly hide: (entry: HiddenTarget) => Effect.Effect<HiddenTarget, Unavailable>
    readonly unhide: (target: string) => Effect.Effect<void, Unavailable>
    readonly list: Effect.Effect<ReadonlyArray<HiddenTarget>, Unavailable>
    /** Whether any of `targets` (an event's id, its author's key) is hidden. */
    readonly covers: (targets: ReadonlyArray<string>) => Effect.Effect<boolean, Unavailable>
  }
>()('Sidequest/Index/Moderation') {
  static readonly layer = Layer.effect(
    Moderation,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const columns = sql`target, kind, reason, hidden_at AS hiddenAt, hidden_by AS hiddenBy`
      const list = SqlSchema.findAll({
        Request: Schema.Void,
        Result: HiddenTarget,
        execute: () =>
          sql`SELECT ${columns} FROM hidden_targets ORDER BY hidden_at DESC, target LIMIT ${hiddenListLimit}`,
      })
      const covering = SqlSchema.findAll({
        Request: Schema.Array(Schema.String),
        Result: Schema.Struct({ target: Schema.String }),
        execute: (targets) => sql`SELECT target FROM hidden_targets WHERE ${sql.in('target', targets)} LIMIT 1`,
      })
      return Moderation.of({
        hide: Effect.fn('Sidequest.Index.hide')(function* (entry) {
          yield* stored(sql`
            INSERT INTO hidden_targets (target, kind, reason, hidden_at, hidden_by)
            VALUES (${entry.target}, ${entry.kind}, ${entry.reason}, ${entry.hiddenAt}, ${entry.hiddenBy})
            ON CONFLICT (target) DO UPDATE SET kind = excluded.kind, reason = excluded.reason,
              hidden_at = excluded.hidden_at, hidden_by = excluded.hidden_by`)
          yield* Effect.logInfo('Sidequest.Index.hidden').pipe(
            Effect.annotateLogs({ target: entry.target, kind: entry.kind, by: entry.hiddenBy }),
          )
          return entry
        }),
        unhide: Effect.fn('Sidequest.Index.unhide')(function* (target) {
          yield* stored(sql`DELETE FROM hidden_targets WHERE target = ${target}`)
          yield* Effect.logInfo('Sidequest.Index.unhidden').pipe(Effect.annotateLogs({ target }))
        }),
        list: stored(list(undefined)),
        covers: (targets) =>
          targets.length === 0
            ? Effect.succeed(false)
            : Effect.map(stored(covering(targets)), (rows) => rows.length > 0),
      })
    }),
  )
}

/** A hide by `moderator` now. */
export const hiddenNow = (target: string, request: Pick<HiddenTarget, 'kind' | 'reason'>, moderator: string) =>
  Effect.map(nowSeconds, (hiddenAt): HiddenTarget => ({
    target,
    kind: request.kind,
    reason: request.reason,
    hiddenAt,
    hiddenBy: moderator,
  }))
