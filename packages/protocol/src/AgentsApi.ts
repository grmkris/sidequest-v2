import { Schema } from 'effect'
import { HttpApiEndpoint, HttpApiGroup } from 'effect/http-api'
import { Agent } from './Agent.ts'
import { AgentToken, IssuedAgentToken, TokenLifetime } from './AgentToken.ts'
import { Grant } from './Grant.ts'
import { SignedIn } from './Guards.ts'
import { AgentId, AgentTokenId } from './Id.ts'
import { Page, PageQuery } from './Page.ts'
import { BadCursor, refusals } from './Refusals.ts'
import { Unavailable } from './SessionApi.ts'

const onAgent = { agent: AgentId }

/**
 * A person's agents: register one under their account, grant it scopes until an expiry, revoke it, list them. And the
 * agent's access tokens for MCP: issue one (shown once), list what was issued, revoke one. A token only identifies the
 * agent; what it may do is the agent's grant, read on every request.
 */
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
    HttpApiEndpoint.post('issueToken', '/api/agents/:agent/tokens', {
      params: onAgent,
      payload: Schema.Struct({ lifetimeSeconds: Schema.optionalKey(TokenLifetime) }),
      success: IssuedAgentToken,
      error: [...refusals, Unavailable],
    }),
    HttpApiEndpoint.get('tokens', '/api/agents/:agent/tokens', {
      params: onAgent,
      query: PageQuery,
      success: Page(AgentToken),
      error: [...refusals, BadCursor, Unavailable],
    }),
    HttpApiEndpoint.post('revokeToken', '/api/agents/:agent/tokens/:token/revoke', {
      params: { ...onAgent, token: AgentTokenId },
      error: [...refusals, Unavailable],
    }),
  )
  .middleware(SignedIn) {}
