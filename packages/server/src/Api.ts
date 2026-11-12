import { SidequestApi } from '@sidequest/protocol'
import { Layer } from 'effect'
import { HttpApiBuilder } from 'effect/http-api'
import { agentsHandlers } from './Http/AgentsHttp.ts'
import { inboxHandlers } from './Http/InboxHttp.ts'
import { jobsHandlers } from './Http/JobsHttp.ts'
import { listingsHandlers } from './Http/ListingsHttp.ts'
import { roomsHandlers } from './Http/RoomsHttp.ts'
import { SameOriginLive } from './Http/SameOriginLive.ts'
import { settlementHandlers } from './Http/SettlementHttp.ts'
import { PeopleClients } from './Http/People.ts'
import { SignedInLive } from './Http/SignedInLive.ts'
import { AgentReads } from './Reads/AgentReads.ts'
import { InboxReads } from './Reads/InboxReads.ts'
import { ListingReads } from './Reads/ListingReads.ts'
import { OpenRequestReads } from './Reads/OpenRequestReads.ts'
import { sessionHandlers } from './SignIn/SessionHttp.ts'
import { systemHandlers } from './Status.ts'

/** The D1 reads the handlers answer lists and single records from; they need the database's `SqlClient`. */
const Reads = Layer.mergeAll(AgentReads.layer, ListingReads.layer, OpenRequestReads.layer, InboxReads.layer)

/**
 * The typed HTTP API's routes: every group of `SidequestApi` with its handlers, the `SameOrigin` and `SignedIn`
 * middleware, and the D1 reads. It needs the hosted model, sign-in's `Sessions`, the database's `SqlClient` and the
 * `Escrow`.
 */
export const apiRoutes = (release: string) =>
  HttpApiBuilder.layer(SidequestApi).pipe(
    Layer.provide([
      systemHandlers(release),
      sessionHandlers,
      agentsHandlers,
      listingsHandlers,
      jobsHandlers,
      settlementHandlers,
      roomsHandlers,
      inboxHandlers,
    ]),
    Layer.provide([SameOriginLive, SignedInLive]),
    Layer.provide(Layer.merge(Reads, PeopleClients.layer)),
  )
