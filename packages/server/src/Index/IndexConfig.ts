import * as Cloudflare from '@alchemy.run/cloudflare'
import { SecretKey } from '@sidequest/nostr'
import { Config, ConfigProvider, Context, Duration, Effect, Layer, Option, Redacted, Result, Schema } from 'effect'
import { allowedRelays, type RelayUrlPolicy, relayUrlOf } from './RelayUrls.ts'

/** How the index talks to relays: how long it waits, how large a message it reads, and how it pages. */
export interface RelayTiming {
  readonly connectTimeout: Duration.Duration
  readonly replyTimeout: Duration.Duration
  /** The longest message read from a relay, in UTF-16 code units; a longer one ends the connection. */
  readonly maxFrameLength: number
  /** Events asked for per page; a page this full is followed by the one before it. */
  readonly pageLimit: number
  /** The most pages one stream of one pass reads; a pass that needs more is incomplete, and is read again. */
  readonly maxPages: number
}

/**
 * The index's relay configuration. `relays` are the stage's default relays, polled and published to; none (the
 * default) means the index connects nowhere, neither to poll nor to relay what it is sent. `overlapSeconds` is how
 * far before the last complete pass a poll starts again, for events signed earlier than they reached a relay (gift
 * wraps are backdated by up to two days). `authKey` signs NIP-42 challenges, when a stage gives one.
 */
export interface IndexConfig {
  readonly relays: ReadonlyArray<string>
  readonly policy: RelayUrlPolicy
  readonly overlapSeconds: number
  readonly authKey: Option.Option<SecretKey>
  readonly timing: RelayTiming
}

/** Two days and fifteen minutes: NIP-59's backdating window and a margin for clocks. */
export const defaultOverlapSeconds = 2 * 86_400 + 15 * 60

/** The most default relays a stage names, and the most of an author's own write relays the outbox adds. */
export const maxDefaultRelays = 8
export const maxAuthorRelays = 4

export const defaultTiming: RelayTiming = {
  connectTimeout: Duration.seconds(5),
  replyTimeout: Duration.seconds(15),
  maxFrameLength: 262_144,
  pageLimit: 500,
  maxPages: 40,
}

/** The index's configuration for this runtime. */
export class IndexSettings extends Context.Service<IndexSettings, IndexConfig>()('Sidequest/Index/IndexSettings') {}

/** The configuration that connects nowhere: no relays. */
export const idleIndex: IndexConfig = {
  relays: [],
  policy: 'public',
  overlapSeconds: defaultOverlapSeconds,
  authKey: Option.none(),
  timing: defaultTiming,
}

/** The index is misconfigured: the variables at fault (never their values). */
export class IndexMisconfigured extends Schema.TaggedError<IndexMisconfigured>()('IndexMisconfigured', {
  names: Schema.Array(Schema.String),
}) {}

/** One variable read: its value, or its name when it is malformed. */
type Read<A> = Result.Result<A, string>

const relayList = (value: unknown): Read<ReadonlyArray<string>> => {
  if (value === undefined || value === '') return Result.succeed([])
  if (typeof value !== 'string') return Result.fail('SIDEQUEST_RELAYS')
  const urls = value.split(',').map((url) => url.trim())
  const valid = urls.every((url) => Option.isSome(relayUrlOf(url, 'public')))
  return valid && urls.length <= maxDefaultRelays
    ? Result.succeed(allowedRelays(urls, 'public', maxDefaultRelays))
    : Result.fail('SIDEQUEST_RELAYS')
}

const overlap = (value: unknown): Read<number> => {
  if (value === undefined || value === '') return Result.succeed(defaultOverlapSeconds)
  const seconds = typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isSafeInteger(seconds) && seconds >= 0
    ? Result.succeed(seconds)
    : Result.fail('SIDEQUEST_RELAY_OVERLAP_SECONDS')
}

const authKey = (value: unknown): Read<Option.Option<SecretKey>> => {
  if (value === undefined || value === '') return Result.succeed(Option.none())
  const key = Schema.decodeUnknownOption(SecretKey)(value)
  return Option.isSome(key) ? Result.succeed(key) : Result.fail('SIDEQUEST_INDEX_KEY')
}

const nameIfWrong = <A>(read: Read<A>): ReadonlyArray<string> => (Result.isFailure(read) ? [read.failure] : [])

/**
 * The index's configuration from a Worker's (or a deploying shell's) variables:
 *
 *   SIDEQUEST_RELAYS                 comma-separated `wss://` URLs of public relays, at most eight; unset, none
 *   SIDEQUEST_RELAY_OVERLAP_SECONDS  the poll's look-back before the last complete pass (default two days, 15 min)
 *   SIDEQUEST_INDEX_KEY              secret: a Nostr secret key (64 hex) that answers NIP-42 challenges; optional
 *
 * Fails with the names of the variables that are malformed.
 */
export const indexConfigFrom = (
  environment: Readonly<Record<string, unknown>>,
): Result.Result<IndexConfig, IndexMisconfigured> => {
  const relays = relayList(environment['SIDEQUEST_RELAYS'])
  const seconds = overlap(environment['SIDEQUEST_RELAY_OVERLAP_SECONDS'])
  const key = authKey(environment['SIDEQUEST_INDEX_KEY'])
  if (Result.isSuccess(relays) && Result.isSuccess(seconds) && Result.isSuccess(key))
    return Result.succeed({
      ...idleIndex,
      relays: relays.success,
      overlapSeconds: seconds.success,
      authKey: key.success,
    })
  return Result.fail(
    new IndexMisconfigured({ names: [...nameIfWrong(relays), ...nameIfWrong(seconds), ...nameIfWrong(key)] }),
  )
}

/**
 * The index's configuration from the Worker's variables. The deploy checked them (`indexVariablesFromShell`), so a
 * malformed set here means variables changed outside a deploy: the index logs the names and stays idle rather than
 * take the API down with it.
 */
export const IndexSettingsLive = Layer.effect(
  IndexSettings,
  Effect.gen(function* () {
    const environment = yield* Cloudflare.Workers.WorkerEnvironment
    const config = indexConfigFrom(environment)
    if (Result.isSuccess(config)) return config.success
    yield* Effect.logError('Sidequest.Index misconfigured; relaying is off').pipe(
      Effect.annotateLogs({ 'sidequest.index.variables': config.failure.names.join(',') }),
    )
    return idleIndex
  }),
)

/** The API Worker's index bindings for a stage: plain text, and the key as `Redacted`, which binds as a secret. */
export type IndexVariables = Readonly<Record<string, string | Redacted.Redacted>>

/**
 * The index's variables from the deploying shell, checked; the key binds as a secret. Unset, the stage is idle.
 * `SIDEQUEST_MODERATOR_PUBKEY` (64 hex), the Nostr key whose NIP-98 alone changes the hide list
 * (`Index/Moderation.ts`), rides along; unset, nobody may.
 */
export const indexVariablesFromShell = Effect.gen(function* () {
  const plain: Record<string, string> = {}
  for (const name of ['SIDEQUEST_RELAYS', 'SIDEQUEST_RELAY_OVERLAP_SECONDS', 'SIDEQUEST_MODERATOR_PUBKEY'] as const) {
    const value = yield* Config.option(Config.String(name))
    if (Option.isSome(value) && value.value !== '') plain[name] = value.value
  }
  const key = Option.filter(
    yield* Config.option(Config.Redacted('SIDEQUEST_INDEX_KEY')),
    (found) => Redacted.value(found) !== '',
  )
  const secrets: Record<string, Redacted.Redacted> = Option.isSome(key) ? { SIDEQUEST_INDEX_KEY: key.value } : {}
  const moderator = plain['SIDEQUEST_MODERATOR_PUBKEY']
  if (moderator !== undefined && !/^[0-9a-f]{64}$/u.test(moderator))
    return yield* Effect.fail(
      new Config.ConfigError(
        new ConfigProvider.SourceError({ message: 'Sidequest.Index.misconfigured: fix SIDEQUEST_MODERATOR_PUBKEY' }),
      ),
    )
  const checked = indexConfigFrom({
    ...plain,
    ...(Option.isSome(key) ? { SIDEQUEST_INDEX_KEY: Redacted.value(key.value) } : {}),
  })
  if (Result.isFailure(checked))
    return yield* Effect.fail(
      new Config.ConfigError(
        new ConfigProvider.SourceError({
          message: `Sidequest.Index.misconfigured: fix ${checked.failure.names.join(', ')}`,
        }),
      ),
    )
  const variables: IndexVariables = { ...plain, ...secrets }
  return variables
})
