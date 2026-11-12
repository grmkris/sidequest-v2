import * as Cloudflare from '@alchemy.run/cloudflare'
import * as AlchemyHttp from 'alchemy/Http'
import { RuntimeContext } from 'alchemy/RuntimeContext'
import { Effect, Layer, Logger } from 'effect'
import { HttpServerRequest } from 'effect/http/HttpServerRequest'
import * as HttpRouter from 'effect/http/HttpRouter'
import { apiRoutes } from './Api.ts'
import { SidequestSql } from './Database.ts'
import { DomainLive } from './DomainLive.ts'
import { SidequestMedia } from './Resources.ts'
import { escrowConfigFrom } from './Settlement/EscrowConfig.ts'
import { escrowLive } from './Settlement/SettlementLive.ts'
import { ArcRpc, arcRpcUrlFrom } from './SignIn/ArcRpc.ts'
import { SignInLive } from './SignIn/SignInLive.ts'
import { releaseFromEnvironment } from './Status.ts'

/** The Cloudflare services the Worker runs on. The Worker is the runtime context its init runs in. */
const Platform = Layer.mergeAll(
  Layer.effect(RuntimeContext, Cloudflare.Worker),
  Cloudflare.Telemetry({ headSamplingRate: 1 }),
  Cloudflare.D1.QueryDatabaseBinding,
  Cloudflare.R2.ReadWriteBucketBinding,
)

/** The Arc testnet RPC client, at the URL the Worker's configuration names. */
const ArcRpcLive = Layer.unwrap(
  Effect.map(Cloudflare.Workers.WorkerEnvironment, (environment) => ArcRpc.layer(arcRpcUrlFrom(environment))),
)

/** Settlement on Arc testnet, if the Worker's configuration names the deployed operator and holds the relayer key. */
const EscrowLive = Layer.unwrap(
  Effect.map(Cloudflare.Workers.WorkerEnvironment, (environment) => escrowLive(escrowConfigFrom(environment))),
)

/** Sign-in and the domain's `Session` middleware, over the model hosted on Durable Objects and D1, and the escrow. */
const Runtime = SignInLive.pipe(
  Layer.provideMerge(DomainLive),
  Layer.provideMerge(EscrowLive),
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
    compatibility: { date: '2026-10-19' },
    workersDev: { enabled: false, previewsEnabled: false },
    observability: { enabled: true, redactQueryString: true, logs: { enabled: true, invocationLogs: true } },
  },
  Effect.gen(function* () {
    yield* declareBindings
    const environment = yield* Cloudflare.Workers.WorkerEnvironment
    const release = releaseFromEnvironment(environment)
    const application = yield* makeApplication(release)
    const fetch = Effect.gen(function* () {
      yield* HttpServerRequest
      return yield* application.handle
    }).pipe(Effect.provideService(Logger.CurrentLoggers, new Set([Logger.consoleStructured])))
    return { fetch }
  }).pipe(Effect.provide(Runtime)),
)
