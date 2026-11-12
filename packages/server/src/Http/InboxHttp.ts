import { SidequestApi, SignedInAccount } from '@sidequest/protocol'
import { Effect } from 'effect'
import { HttpApiBuilder } from 'effect/http-api'
import { InboxReads } from '../Reads/InboxReads.ts'

/** The `inbox` group: the signed-in person's inbox, from the `inbox_items` projection, oldest or newest first. */
export const inboxHandlers = HttpApiBuilder.group(SidequestApi, 'inbox', (handlers) =>
  Effect.gen(function* () {
    const inbox = yield* InboxReads
    return handlers
      .handle('read', ({ query }) => Effect.flatMap(SignedInAccount, (account) => inbox.page(account, query)))
      .handle('recent', ({ query }) => Effect.flatMap(SignedInAccount, (account) => inbox.recent(account, query)))
  }),
)
