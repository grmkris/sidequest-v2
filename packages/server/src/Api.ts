import { ServedApi } from '@sidequest/fold/api'
import { HttpApiBuilder } from 'effect/http-api'
import { Layer } from 'effect'
import { erc8004EntryRoute, erc8004Handlers } from './Http/Erc8004Http.ts'
import { escrowHandlers } from './Http/EscrowHttp.ts'
import { eventsHandlers } from './Http/EventsHttp.ts'
import { indexJobsHandlers } from './Http/IndexReadsHttp.ts'
import { operationsHandlers } from './Http/OperationsHttp.ts'
import { systemHandlers } from './Status.ts'

/**
 * The API Worker's routes: the typed HTTP API (`ServedApi`: the status, the index's events and reads, its jobs, the
 * escrow, the stage's operations and ERC-8004's files) with its handlers, and beside it the one raw route, ERC-8004 feedback entries as exact
 * bytes. It needs the index (`IndexLive`), `Settlement`, `ArcRpc`, the escrow's settings and the database's
 * `SqlClient`.
 */
export const apiRoutes = (release: string) =>
  Layer.merge(
    HttpApiBuilder.layer(ServedApi).pipe(
      Layer.provide([
        systemHandlers(release),
        eventsHandlers,
        indexJobsHandlers,
        escrowHandlers,
        operationsHandlers,
        erc8004Handlers,
      ]),
    ),
    erc8004EntryRoute,
  )
