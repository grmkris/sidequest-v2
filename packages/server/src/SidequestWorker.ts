import * as Cloudflare from '@alchemy.run/cloudflare'
import * as AlchemyHttp from 'alchemy/Http'
import { RuntimeContext } from 'alchemy/RuntimeContext'
import { Effect, Layer, Logger, Option } from 'effect'
import { HttpServerRequest } from 'effect/http/HttpServerRequest'
import * as HttpRouter from 'effect/http/HttpRouter'
import { apiRoutes } from './Api.ts'
import { SidequestSql } from './Database.ts'
import { SidequestMedia } from './Resources.ts'
import { IndexSettingsLive } from './Index/IndexConfig.ts'
import { ChainLogPoller } from './Index/ChainLogPoller.ts'
import { IndexLive, indexSchedule } from './Index/IndexLive.ts'
import { EscrowSettings, escrowSettingsFrom, operatorDeployBlockFrom } from './Escrow/EscrowSettings.ts'
import { Settler } from './Escrow/Settler.ts'
import { LaunchCapSettings, launchCapsFrom } from './Escrow/LaunchCaps.ts'
import { ModerationSettings, moderationSettingsFrom } from './Index/Moderation.ts'
import { ArcRpc, arcRpcUrlFrom } from './Settlement/ArcRpc.ts'
import { settlementConfigFrom } from './Settlement/SettlementConfig.ts'
import { ChainRpcFromArc, settlementLive } from './Settlement/SettlementLive.ts'
import { releaseFromEnvironment } from './Status.ts'

/** The Cloudflare services the Worker runs on. The Worker is the runtime context its init runs in. */
const Platform = Layer.mergeAll(
  Layer.effect(RuntimeContext, Cloudflare.Worker),
  Cloudflare.Telemetry({ headSamplingRate: 1 }),
  Cloudflare.D1.QueryDatabaseBinding,
  Cloudflare.R2.ReadWriteBucketBinding,
  Cloudflare.Workers.CronEventSourceLive,
)

/** The Arc testnet RPC client, at the URL the Worker's configuration names. */
const ArcRpcLive = Layer.unwrap(
  Effect.map(Cloudflare.Workers.WorkerEnvironment, (environment) => ArcRpc.layer(arcRpcUrlFrom(environment))),
)

/** Settlement on Arc testnet, if the Worker's configuration names the deployed operator and holds the relayer key. */
const SettlementLive = Layer.unwrap(
  Effect.map(Cloudflare.Workers.WorkerEnvironment, (environment) => settlementLive(settlementConfigFrom(environment))),
)

/**
 * The chain log poller on the settlement chain, if the Worker's configuration names one; otherwise disabled. It reads
 * through the same Arc RPC client as settlement, from the operator's deployment block
 * (`SIDEQUEST_OPERATOR_DEPLOY_BLOCK`) on its first run, or without one from the confirmed head.
 */
const ChainLogPollerLive = Layer.unwrap(
  Effect.map(Cloudflare.Workers.WorkerEnvironment, (environment) =>
    Option.match(settlementConfigFrom(environment), {
      onNone: () => ChainLogPoller.disabled,
      onSome: ({ chain }) =>
        ChainLogPoller.layer(chain, operatorDeployBlockFrom(environment)).pipe(Layer.provide(ChainRpcFromArc)),
    }),
  ),
)

/** The escrow's settings (the arbitration key), from the Worker's variables. */
const EscrowSettingsLive = Layer.effect(
  EscrowSettings,
  Effect.map(Cloudflare.Workers.WorkerEnvironment, escrowSettingsFrom),
)

/** The stage's launch caps and its moderator key, from the Worker's variables; unset, there are none. */
const StageGuardsLive = Layer.mergeAll(
  Layer.effect(LaunchCapSettings, Effect.map(Cloudflare.Workers.WorkerEnvironment, launchCapsFrom)),
  Layer.effect(ModerationSettings, Effect.map(Cloudflare.Workers.WorkerEnvironment, moderationSettingsFrom)),
)

/** The index, the chain log poller, the settler and the escrow's settings, each configured by the Worker's variables,
 * over settlement, the Arc RPC client and D1. */
const Runtime = Layer.mergeAll(ChainLogPollerLive, Settler.layer, EscrowSettingsLive, StageGuardsLive).pipe(
  Layer.provideMerge(IndexLive.pipe(Layer.provide(IndexSettingsLive))),
  Layer.provideMerge(SettlementLive),
  Layer.provideMerge(ArcRpcLive),
  Layer.provideMerge(SidequestSql),
  Layer.provideMerge(Platform),
)

const declareBindings = Cloudflare.R2.ReadWriteBucket(SidequestMedia)

const makeApplication = (release: string) =>
  Effect.gen(function* () {
    const routes = apiRoutes(release).pipe(Layer.provide(AlchemyHttp.Platform))
    const handle = yield* HttpRouter.toHttpEffect(routes).pipe(Effect.orDie)
    return { handle }
  })

export class SidequestWorker extends Cloudflare.Worker<SidequestWorker, Cloudflare.WorkerShape>()('SidequestWorker') {}

export default SidequestWorker.make(
  {
    main: import.meta.url,
    // `fetch` reaches only the public internet, never this zone's origin: the RPC endpoint is one the configuration
    // names.
    compatibility: { date: '2026-10-19', flags: ['global_fetch_strictly_public'] },
    workersDev: { enabled: false, previewsEnabled: false },
    observability: { enabled: true, redactQueryString: true, logs: { enabled: true, invocationLogs: true } },
  },
  Effect.gen(function* () {
    yield* declareBindings
    const environment = yield* Cloudflare.Workers.WorkerEnvironment
    const release = releaseFromEnvironment(environment)
    const application = yield* makeApplication(release)
    yield* indexSchedule
    const fetch = Effect.gen(function* () {
      yield* HttpServerRequest
      return yield* application.handle
    }).pipe(Effect.provideService(Logger.CurrentLoggers, new Set([Logger.consoleStructured])))
    return { fetch }
  }).pipe(Effect.provide(Runtime)),
)
