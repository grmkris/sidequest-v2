import { SidequestApi } from '@sidequest/protocol'
import { Layer } from 'effect'
import { HttpApiBuilder } from 'effect/http-api'
import { accountHandlers } from './Http/AccountHttp.ts'
import { agentsHandlers } from './Http/AgentsHttp.ts'
import { inboxHandlers } from './Http/InboxHttp.ts'
import { jobsHandlers } from './Http/JobsHttp.ts'
import { listingsHandlers } from './Http/ListingsHttp.ts'
import { roomsHandlers } from './Http/RoomsHttp.ts'
import { SameOriginLive } from './Http/SameOriginLive.ts'
import { settlementHandlers } from './Http/SettlementHttp.ts'
import { PeopleClients } from './Http/People.ts'
import { SignedInLive } from './Http/SignedInLive.ts'
import { mcpRoutes } from './Mcp/McpRoutes.ts'
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

/**
 * The API Worker's routes: the typed HTTP API (every group of `SidequestApi` with its handlers and the `SameOrigin`
 * and `SignedIn` middleware) and the MCP endpoint, two transports over the same model and D1 reads. It needs the
 * hosted model, sign-in's `Sessions` and `AgentAccess`, the database's `SqlClient` and the `Escrow`.
 */
export const apiRoutes = (release: string) =>
  Layer.mergeAll(
    HttpApiBuilder.layer(SidequestApi).pipe(
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
      ]),
      Layer.provide([SameOriginLive, SignedInLive]),
    ),
    mcpRoutes(release),
  ).pipe(Layer.provide(Layer.merge(Reads, PeopleClients.layer)))
