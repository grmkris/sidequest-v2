import { unixSeconds } from '@sidequest/domain/Authority'
import {
  defaultTokenLifetimeSeconds,
  Forbidden,
  generateId,
  NotFound,
  SidequestApi,
  SignedInAccount,
} from '@sidequest/protocol'
import { DateTime, Effect } from 'effect'
import * as HttpEffect from 'effect/http/HttpEffect'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import { HttpApiBuilder } from 'effect/http-api'
import { AgentAccess } from '../Agents/AgentAccess.ts'
import { AgentTokens } from '../Agents/AgentTokens.ts'
import { AgentReads } from '../Reads/AgentReads.ts'
import { PeopleClients, signedIn } from './People.ts'

/** A response that carries a secret: no cache, shared or private, may keep it (RFC 6749 §5.1). */
const uncached = HttpEffect.appendPreResponseHandler((_, response) =>
  Effect.succeed(HttpServerResponse.setHeader(response, 'cache-control', 'no-store')),
)

/**
 * The `agents` group: the signed-in person's agents, registered under a server-minted id, and their access tokens.
 * Tokens are issued, listed and revoked only by the agent's operator; a revoked agent gets no new token.
 */
export const agentsHandlers = HttpApiBuilder.group(SidequestApi, 'agents', (handlers) =>
  Effect.gen(function* () {
    const agents = yield* AgentReads
    const access = yield* AgentAccess
    const tokens = yield* AgentTokens
    const asPerson = signedIn(yield* PeopleClients)
    const operated = (agent: Parameters<typeof access.operated>[1]) =>
      Effect.flatMap(SignedInAccount, (account) => access.operated(account, agent))
    const now = Effect.map(DateTime.now, unixSeconds)
    return handlers
      .handle('register', ({ payload }) =>
        Effect.gen(function* () {
          const id = yield* generateId('AgentId')
          yield* asPerson.ask((people) => people.RegisterAgent({ target: id, ...payload }))
          return { id }
        }),
      )
      .handle('grant', ({ params, payload }) =>
        asPerson.send((people) => people.GrantAgent({ target: params.agent, grant: payload })),
      )
      .handle('revoke', ({ params }) => asPerson.send((people) => people.RevokeGrant({ target: params.agent })))
      .handle('list', ({ query }) =>
        Effect.gen(function* () {
          return yield* agents.page(yield* SignedInAccount, query)
        }),
      )
      .handle('issueToken', ({ params, payload }) =>
        Effect.gen(function* () {
          const agent = yield* operated(params.agent)
          if (agent.revoked) return yield* new Forbidden({ reason: 'AgentRevoked', evidence: { agent: params.agent } })
          yield* uncached
          return yield* tokens.issue(params.agent, payload.lifetimeSeconds ?? defaultTokenLifetimeSeconds, yield* now)
        }),
      )
      .handle('tokens', ({ params, query }) => Effect.andThen(operated(params.agent), tokens.page(params.agent, query)))
      .handle('revokeToken', ({ params }) =>
        Effect.gen(function* () {
          yield* operated(params.agent)
          const revoked = yield* tokens.revoke(params.agent, params.token, yield* now)
          if (!revoked)
            return yield* new NotFound({
              reason: 'UnknownToken',
              evidence: { agent: params.agent, token: params.token },
            })
        }),
      )
  }),
)
