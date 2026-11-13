import { HttpApi, HttpApiEndpoint, HttpApiGroup } from 'effect/http-api'
import { AccountApi } from './AccountApi.ts'
import { AgentsApi } from './AgentsApi.ts'
import { ConnectApi } from './ConnectApi.ts'
import { EventsApi } from './EventsGroup.ts'
import { IndexSettlementApi } from './IndexSettlementGroup.ts'
import { SameOrigin } from './Guards.ts'
import { InboxApi } from './InboxApi.ts'
import { JobsApi } from './JobsApi.ts'
import { ListingsApi } from './ListingsGroup.ts'
import { RoomsApi } from './RoomsApi.ts'
import { SessionApi } from './SessionGroup.ts'
import { SettlementApi } from './SettlementApi.ts'
import { Status } from './Status.ts'

export class SystemApi extends HttpApiGroup.make('system').add(
  HttpApiEndpoint.get('status', '/api/status', { success: Status }),
) {}

/**
 * Sidequest's HTTP API. Every endpoint refuses a state-changing request from another site ({@link SameOrigin}), except
 * the index's ({@link EventsApi}) and the sessionless escrow ({@link IndexSettlementApi}, whose wallet signatures are
 * their own authority), which are added after the middleware so it never receives them: `HttpApi.middleware`
 * applies to the groups added before it only. Publishing a signed event uses nothing ambient (no cookie, no session,
 * no credential a browser attaches), so another site making a browser send one can do no more than the event's
 * author could by sending it themselves.
 */
export class SidequestApi extends HttpApi.make('sidequest')
  .add(
    SystemApi,
    SessionApi,
    AccountApi,
    AgentsApi,
    ListingsApi,
    JobsApi,
    SettlementApi,
    RoomsApi,
    InboxApi,
    ConnectApi,
  )
  .middleware(SameOrigin)
  .add(EventsApi, IndexSettlementApi) {}
