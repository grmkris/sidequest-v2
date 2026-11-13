import type { ServedApi } from '@sidequest/fold/api'
import { Context, Effect, Exit, Layer, Schema } from 'effect'
import * as HttpClient from 'effect/http/HttpClient'
import type * as HttpApiClient from 'effect/http-api/HttpApiClient'

/** The browser could not load the code of its API client; the next request tries again. */
export class ClientNotLoaded extends Schema.TaggedError<ClientNotLoaded>()('ClientNotLoaded', {}) {}

/** Sidequest's typed API and the index's job reads (`ServedApi`), called from the browser on the site's own origin.
 * No request carries a credential: what changes state carries its own signature. */
export class SidequestClient extends Context.Service<
  SidequestClient,
  {
    /** The client derived from `ServedApi`; its code loads the first time a page asks for it. */
    readonly api: Effect.Effect<HttpApiClient.ForApi<typeof ServedApi>, ClientNotLoaded>
  }
>()('@sidequest/web/SidequestClient') {}

export const sidequestClientLayer = (origin: string) =>
  Layer.effect(
    SidequestClient,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient
      const api = yield* Effect.cachedWithTTL(
        Effect.tryPromise({ try: () => import('./ApiClient.ts'), catch: () => new ClientNotLoaded() }).pipe(
          Effect.flatMap(({ makeApi }) => makeApi(origin)),
          Effect.provideService(HttpClient.HttpClient, http),
        ),
        (exit) => (Exit.isSuccess(exit) ? 'Infinity' : 0),
      )
      return SidequestClient.of({ api })
    }),
  )

/** The typed client's own type. */
export type SidequestApiClient = HttpApiClient.ForApi<typeof ServedApi>
