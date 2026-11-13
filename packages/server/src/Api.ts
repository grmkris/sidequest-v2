import { ServedApi } from '@sidequest/fold/api'
import { HttpApiBuilder } from 'effect/http-api'
import { Layer } from 'effect'
import { escrowHandlers } from './Http/EscrowHttp.ts'
import { eventsHandlers } from './Http/EventsHttp.ts'
import { indexJobsHandlers } from './Http/IndexReadsHttp.ts'
import { systemHandlers } from './Status.ts'

/**
 * The API Worker's routes: the typed HTTP API (`ServedApi`: the status, the index's events and reads, its jobs and the
 * escrow) with its handlers. It needs the index (`IndexLive`), `Settlement`, `ArcRpc`, the escrow's settings and the
 * database's `SqlClient`.
 */
export const apiRoutes = (release: string) =>
  HttpApiBuilder.layer(ServedApi).pipe(
    Layer.provide([systemHandlers(release), eventsHandlers, indexJobsHandlers, escrowHandlers]),
  )
