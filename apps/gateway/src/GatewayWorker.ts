import * as Cloudflare from '@alchemy.run/cloudflare'
import * as D1Client from '@effect/sql-d1/D1Client'
import { ClientDocuments } from '@sidequest/serving/ClientDocuments'
import * as AlchemyHttp from 'alchemy/Http'
import { RuntimeContext } from 'alchemy/RuntimeContext'
import { Effect, Layer, Logger, Result } from 'effect'
import * as HttpRouter from 'effect/http/HttpRouter'
import { HttpServerRequest } from 'effect/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import { CoreLive } from './Core/Core.ts'
import { GatewayDatabase } from './Resources.ts'
import { gatewayRoutes } from './Routes.ts'
import { type GatewayConfig, GatewaySettings, settingsFrom } from './Settings.ts'

/** The Cloudflare services the Worker runs on. The Worker is the runtime context its init runs in. */
const Platform = Layer.mergeAll(
  Layer.effect(RuntimeContext, Cloudflare.Worker),
  Cloudflare.Telemetry({ headSamplingRate: 1 }),
  Cloudflare.D1.QueryDatabaseBinding,
)

/** The gateway's own D1 as Effect's `SqlClient`. */
const GatewaySql = Layer.unwrap(
  Effect.gen(function* () {
    const database = yield* Cloudflare.D1.QueryDatabase(GatewayDatabase)
    return D1Client.layer({ db: yield* database.raw })
  }),
)

/** The Worker's own services: its D1 and the platform. Declaring them is what binds them, so they never wait on settings. */
const Runtime = GatewaySql.pipe(Layer.provideMerge(Platform))

/** The routes over the core at the configured URL, with the settings the Worker's variables give. */
const servedWith = (settings: GatewayConfig) =>
  gatewayRoutes(settings.release).pipe(
    Layer.provide(AlchemyHttp.Platform),
    Layer.provide(Layer.mergeAll(CoreLive, ClientDocuments.layer)),
    Layer.provide(Layer.succeed(GatewaySettings, settings)),
  )

/** Every request's answer while the Worker's variables are missing or malformed, as when Alchemy plans the Worker. */
const misconfigured = (name: string) =>
  Effect.logError('Sidequest.Gateway misconfigured').pipe(
    Effect.annotateLogs({ 'sidequest.gateway.variable': name }),
    Effect.as(HttpServerResponse.jsonUnsafe({ error: 'misconfigured' }, { status: 503 })),
  )

export class GatewayWorker extends Cloudflare.Worker<GatewayWorker, Cloudflare.WorkerShape>()('SidequestGateway') {}

/**
 * The agent gateway's Worker: its own origin and D1, reaching the core only at `SIDEQUEST_CORE_URL`. `fetch` reaches
 * only the public internet, never this zone's origin: MCP clients' metadata documents come from URLs a client names.
 */
export default GatewayWorker.make(
  {
    main: import.meta.url,
    compatibility: { date: '2026-10-19', flags: ['global_fetch_strictly_public'] },
    workersDev: true,
    observability: { enabled: true, redactQueryString: true, logs: { enabled: true, invocationLogs: true } },
  },
  Effect.gen(function* () {
    const settings = settingsFrom(yield* Cloudflare.Workers.WorkerEnvironment)
    if (Result.isFailure(settings)) return { fetch: misconfigured(settings.failure.name) }
    const handle = yield* HttpRouter.toHttpEffect(servedWith(settings.success)).pipe(Effect.orDie)
    const fetch = Effect.gen(function* () {
      yield* HttpServerRequest
      return yield* handle
    }).pipe(Effect.provideService(Logger.CurrentLoggers, new Set([Logger.consoleStructured])))
    return { fetch }
  }).pipe(Effect.provide(Runtime)),
)
