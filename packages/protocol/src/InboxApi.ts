import { Schema } from 'effect'
import { HttpApiEndpoint, HttpApiGroup } from 'effect/http-api'
import { SignedIn } from './Guards.ts'
import { InboxEntry } from './Inbox.ts'
import { Cursor, PageQuery } from './Page.ts'
import { BadCursor } from './Refusals.ts'

/**
 * The signed-in person's inbox, oldest first: the items after a cursor. `next` is always the cursor after the last
 * item returned (or the one given, when nothing new arrived), so a reader polls with it; `more` says whether items
 * after it are waiting already.
 */
export class InboxApi extends HttpApiGroup.make('inbox')
  .add(
    HttpApiEndpoint.get('read', '/api/inbox', {
      query: PageQuery,
      success: Schema.Struct({ items: Schema.Array(InboxEntry), next: Cursor, more: Schema.Boolean }),
      error: BadCursor,
    }),
  )
  .middleware(SignedIn) {}
