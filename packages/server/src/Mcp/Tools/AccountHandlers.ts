import { AccountTools } from '@sidequest/protocol'
import { Effect } from 'effect'
import { InboxReads } from '../../Reads/InboxReads.ts'
import { currentCaller } from '../McpCaller.ts'

/** `whoami` from the caller the bearer token let in, and `list_inbox` from the operator's inbox in D1. */
export const AccountHandlers = AccountTools.toLayer(
  Effect.gen(function* () {
    const inbox = yield* InboxReads
    return AccountTools.of({
      whoami: () =>
        Effect.map(currentCaller, ({ actor: { account, agent }, token }) => ({
          account,
          agent: { id: agent.id, scopes: agent.scopes, grantExpiresAt: agent.expiresAt },
          token: { id: token.id, expiresAt: token.expiresAt },
        })),
      list_inbox: ({ limit, cursor }) =>
        Effect.flatMap(currentCaller, ({ actor }) => inbox.page(actor.account, { limit, cursor })),
    })
  }),
)
