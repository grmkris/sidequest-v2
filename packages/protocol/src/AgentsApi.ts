import { Schema } from 'effect'
import { HttpApiEndpoint, HttpApiGroup } from 'effect/http-api'
import { Agent } from './Agent.ts'
import { Grant } from './Grant.ts'
import { SignedIn } from './Guards.ts'
import { AgentId } from './Id.ts'
import { Page, PageQuery } from './Page.ts'
import { BadCursor, refusals } from './Refusals.ts'

const onAgent = { agent: AgentId }

/** A person's agents: register one under their account, grant it scopes until an expiry, revoke it, list them. */
export class AgentsApi extends HttpApiGroup.make('agents')
  .add(
    HttpApiEndpoint.post('register', '/api/agents', {
      payload: Schema.Struct({ name: Agent.fields.name }),
      success: Schema.Struct({ id: AgentId }),
      error: refusals,
    }),
    HttpApiEndpoint.put('grant', '/api/agents/:agent/grant', { params: onAgent, payload: Grant, error: refusals }),
    HttpApiEndpoint.post('revoke', '/api/agents/:agent/revoke', { params: onAgent, error: refusals }),
    HttpApiEndpoint.get('list', '/api/agents', { query: PageQuery, success: Page(Agent), error: BadCursor }),
  )
  .middleware(SignedIn) {}
