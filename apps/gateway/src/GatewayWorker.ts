import * as Cloudflare from '@alchemy.run/cloudflare'
import * as D1Client from '@effect/sql-d1/D1Client'
import { ClientDocuments } from '@sidequest/serving/ClientDocuments'
import * as AlchemyHttp from 'alchemy/Http'
import { RuntimeContext } from 'alchemy/RuntimeContext'
import { Effect, Layer, Logger, Result } from 'effect'
import * as HttpRouter from 'effect/http/HttpRouter'
import { HttpServerRequest } from 'effect/http/HttpServerRequest'
import { CoreLive } from './Core/Core.ts'
import { GatewayDatabase } from './Resources.ts'
import { gatewayRoutes } from './Routes.ts'
import { GatewaySettings, settingsFrom } from './Settings.ts'

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

/** The settings from the Worker's variables; a Worker deployed without them is a deployment defect. */
const SettingsLive = Layer.effect(
  GatewaySettings,
  Effect.flatMap(Cloudflare.Workers.WorkerEnvironment, (environment) =>
    Result.match(settingsFrom(environment), {
      onFailure: ({ name }) => Effect.die(new Error(`Sidequest.Gateway misconfigured: ${name}`)),
      onSuccess: Effect.succeed,
    }),
  ),
)

const Runtime = Layer.mergeAll(CoreLive, ClientDocuments.layer).pipe(
  Layer.provideMerge(SettingsLive),
  Layer.provideMerge(GatewaySql),
  Layer.provideMerge(Platform),
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
    const { release } = yield* GatewaySettings
    const routes = gatewayRoutes(release).pipe(Layer.provide(AlchemyHttp.Platform))
    const handle = yield* HttpRouter.toHttpEffect(routes).pipe(Effect.orDie)
    const fetch = Effect.gen(function* () {
      yield* HttpServerRequest
      return yield* handle
    }).pipe(Effect.provideService(Logger.CurrentLoggers, new Set([Logger.consoleStructured])))
    return { fetch }
  }).pipe(Effect.provide(Runtime)),
)
