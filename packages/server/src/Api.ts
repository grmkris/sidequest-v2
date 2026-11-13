import { Layer } from 'effect'
import { HttpApiBuilder } from 'effect/http-api'
import { accountHandlers } from './Http/AccountHttp.ts'
import { agentsHandlers } from './Http/AgentsHttp.ts'
import { eventsHandlers } from './Http/EventsHttp.ts'
import { inboxHandlers } from './Http/InboxHttp.ts'
import { ServedApi } from '@sidequest/fold/api'
import { indexJobsHandlers } from './Http/IndexReadsHttp.ts'
import { indexSettlementHandlers } from './Http/IndexSettlementHttp.ts'
import { jobsHandlers } from './Http/JobsHttp.ts'
import { listingsHandlers } from './Http/ListingsHttp.ts'
import { roomsHandlers } from './Http/RoomsHttp.ts'
import { SameOriginLive } from './Http/SameOriginLive.ts'
import { settlementHandlers } from './Http/SettlementHttp.ts'
import { PeopleClients } from './Http/People.ts'
import { SignedInLive } from './Http/SignedInLive.ts'
import { mcpRoutes } from './Mcp/McpRoutes.ts'
import { connectHandlers } from './OAuth/ConnectHttp.ts'
import { ConnectRequests, OAuthClients } from '@sidequest/serving/OAuthRequests'
import { Connections } from './OAuth/OAuthStore.ts'
import { oauthRoutes } from './OAuth/OAuthRoutes.ts'
import { AccountNameReads } from './Reads/AccountNameReads.ts'
import { AgentReads } from './Reads/AgentReads.ts'
import { InboxReads } from './Reads/InboxReads.ts'
import { ListingReads } from './Reads/ListingReads.ts'
import { OpenRequestReads } from './Reads/OpenRequestReads.ts'
import { PartyJobReads } from './Reads/PartyJobReads.ts'
import { sessionHandlers } from './SignIn/SessionHttp.ts'
import { systemHandlers } from './Status.ts'

/** The D1 reads the handlers answer lists and single records from; they need the database's `SqlClient`. */
const Reads = Layer.mergeAll(
  AgentReads.layer,
  AccountNameReads.layer,
  ListingReads.layer,
  OpenRequestReads.layer,
  PartyJobReads.layer,
  InboxReads.layer,
)

/** OAuth's D1 stores: self-registered clients, requests waiting for consent, connections and their tokens. */
const OAuthStores = Layer.mergeAll(OAuthClients.layer, ConnectRequests.layer, Connections.layer)

/**
 * The API Worker's routes: the typed HTTP API (every group of `SidequestApi` and the index's jobs, with their handlers
 * and the `SameOrigin` and `SignedIn` middleware) and the MCP endpoint, two transports over the same model and D1 reads. It needs the
 * hosted model, sign-in's `Sessions` and `AgentAccess`, the database's `SqlClient`, the `Escrow` and the index
 * (`IndexLive`).
 */
export const apiRoutes = (release: string) =>
  Layer.mergeAll(
    HttpApiBuilder.layer(ServedApi).pipe(
      Layer.provide([
        systemHandlers(release),
        sessionHandlers,
        accountHandlers,
        agentsHandlers,
        listingsHandlers,
        jobsHandlers,
        settlementHandlers,
        roomsHandlers,
        inboxHandlers,
        connectHandlers,
        eventsHandlers,
        indexJobsHandlers,
        indexSettlementHandlers,
      ]),
      Layer.provide([SameOriginLive, SignedInLive]),
    ),
    mcpRoutes(release),
    oauthRoutes,
  ).pipe(Layer.provide(Layer.mergeAll(Reads, OAuthStores, PeopleClients.layer)))
