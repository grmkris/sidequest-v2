import { Agent, Cursor, InboxEntry, JobView, Listing, OpenRequest, Page, SessionView } from '@sidequest/protocol'
import { Schema } from 'effect'
import { defineTaggedUnion } from 'foldkit/schema'
import { Names } from './Names.ts'

// What the server read for the page it rendered, stamped into the document with the Flags, so hydration starts from
// the same data the HTML shows and reads nothing again.

/** The newest page of an inbox: its items newest first, the cursor of the older page, and the one to poll with. */
export const RecentInbox = Schema.Struct({
  items: Schema.Array(InboxEntry),
  next: Schema.NullOr(Cursor),
  latest: Cursor,
})
export type RecentInbox = typeof RecentInbox.Type

/** The data of the page the server rendered, or none: a page it did not read for, or a read that failed. */
export const Preload = defineTaggedUnion({
  Nothing: {},
  Home: { requests: Page(OpenRequest), listings: Page(Listing), names: Names },
  Listing: { listing: Listing, names: Names },
  Job: { view: JobView, names: Names },
  Inbox: { recent: RecentInbox },
  Agents: { agents: Page(Agent) },
})
export type Preload = typeof Preload.Type

/** Who the server found signed in: not asked (no session cookie, or the read failed), someone, or no one. */
export const SessionRead = defineTaggedUnion({
  Unread: {},
  SignedIn: { session: SessionView },
  SignedOut: {},
})
export type SessionRead = typeof SessionRead.Type
