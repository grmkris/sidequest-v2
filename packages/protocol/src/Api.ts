import { HttpApi, HttpApiEndpoint, HttpApiGroup } from 'effect/http-api'
import { AccountApi } from './AccountApi.ts'
import { AgentsApi } from './AgentsApi.ts'
import { SameOrigin } from './Guards.ts'
import { InboxApi } from './InboxApi.ts'
import { JobsApi } from './JobsApi.ts'
import { ListingsApi } from './ListingsApi.ts'
import { RoomsApi } from './RoomsApi.ts'
import { SessionApi } from './SessionApi.ts'
import { SettlementApi } from './SettlementApi.ts'
import { Status } from './Status.ts'

export class SystemApi extends HttpApiGroup.make('system').add(
  HttpApiEndpoint.get('status', '/api/status', { success: Status }),
) {}

/** Sidequest's HTTP API. Every endpoint refuses a state-changing request from another site ({@link SameOrigin}). */
export class SidequestApi extends HttpApi.make('sidequest')
  .add(SystemApi, SessionApi, AccountApi, AgentsApi, ListingsApi, JobsApi, SettlementApi, RoomsApi, InboxApi)
  .middleware(SameOrigin) {}
