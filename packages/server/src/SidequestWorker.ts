import * as Cloudflare from '@alchemy.run/cloudflare'
import * as AlchemyHttp from 'alchemy/Http'
import { Effect, Layer, Logger } from 'effect'
import { HttpServerRequest } from 'effect/http/HttpServerRequest'
import * as HttpRouter from 'effect/http/HttpRouter'
import { health } from './Health.ts'
import { SidequestDatabase, SidequestMedia } from './Resources.ts'
import { DomainLive } from './DomainLive.ts'

const Runtime = Layer.mergeAll(
  DomainLive,
  Cloudflare.Telemetry({ headSamplingRate: 1 }),
  Cloudflare.D1.QueryDatabaseBinding,
  Cloudflare.R2.ReadWriteBucketBinding,
)

const declareBindings = Effect.gen(function* () {
  const database = yield* Cloudflare.D1.QueryDatabase(SidequestDatabase)
  const media = yield* Cloudflare.R2.ReadWriteBucket(SidequestMedia)
  return { database, media }
})

const makeApplication = (release: string) =>
  Effect.gen(function* () {
    const routes = HttpRouter.add('GET', '/api/health', health(release)).pipe(Layer.provide(AlchemyHttp.Platform))
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
    const release = 'local-build'
    const application = yield* makeApplication(release)
    const fetch = Effect.gen(function* () {
      yield* HttpServerRequest
      return yield* application.handle
    }).pipe(Effect.provideService(Logger.CurrentLoggers, new Set([Logger.consoleStructured])))
    return { fetch }
  }).pipe(Effect.provide(Runtime)),
)
