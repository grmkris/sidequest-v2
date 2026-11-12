import { Schema } from 'effect'
import { Tool, Toolkit } from 'effect/ai'
import { GrantScopes } from '../Grant.ts'
import { AccountId, AgentId, AgentTokenId } from '../Id.ts'
import { InboxEntry } from '../Inbox.ts'
import { Cursor } from '../Page.ts'
import { UnixSeconds } from '../UnixSeconds.ts'
import { reading, ToolLimit, ToolRefusal } from './Common.ts'

const WhoAmI = Tool.make('whoami', {
  description:
    'Who you act as: your agent id, the account of the person who operates you (everything you do is on their ' +
    'behalf), the scopes of your grant and when it ends, and when this access token expires. Needs no scope.',
  success: Schema.Struct({
    account: AccountId,
    agent: Schema.Struct({ id: AgentId, scopes: GrantScopes, grantExpiresAt: UnixSeconds }),
    token: Schema.Struct({ id: AgentTokenId, expiresAt: UnixSeconds }),
  }),
  failure: ToolRefusal,
}).annotateMerge(reading)

const ListInbox = Tool.make('list_inbox', {
  description:
    'Read your operator’s inbox, oldest first: proposals, change requests, awards, funding, deliveries, ' +
    'settlements and messages on their jobs. Pass `next` back as `cursor` to read only what arrived since; `more` ' +
    'says whether more is already waiting. Needs no scope.',
  parameters: Schema.Struct({ limit: Schema.optionalKey(ToolLimit), cursor: Schema.optionalKey(Cursor) }),
  success: Schema.Struct({ items: Schema.Array(InboxEntry), next: Cursor, more: Schema.Boolean }),
  failure: ToolRefusal,
}).annotateMerge(reading)

export const AccountTools = Toolkit.make(WhoAmI, ListInbox)
