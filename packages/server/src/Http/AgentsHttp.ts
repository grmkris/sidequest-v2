import { generateId, SidequestApi, SignedInAccount } from '@sidequest/protocol'
import { Effect } from 'effect'
import { HttpApiBuilder } from 'effect/http-api'
import { AgentReads } from '../Reads/AgentReads.ts'
import { PeopleClients, signedIn } from './People.ts'

/** The `agents` group: the signed-in person's agents, registered under a server-minted id. */
export const agentsHandlers = HttpApiBuilder.group(SidequestApi, 'agents', (handlers) =>
  Effect.gen(function* () {
    const agents = yield* AgentReads
    const asPerson = signedIn(yield* PeopleClients)
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
  }),
)
