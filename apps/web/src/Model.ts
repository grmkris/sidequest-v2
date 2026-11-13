import { Schema } from 'effect'
import { defineTaggedUnion } from 'foldkit/schema'
import { Language } from './Language.ts'
import { Me } from './Me.ts'
import { Preload, SessionRead } from './Preload.ts'
import { Problem } from './Problem.ts'
import { AppRoute } from './route.ts'
import { Session } from './Session.ts'
import * as Pages from './Pages.ts'

/** What the server stamps into the page and hydration reads back: the reader's language, the time zone dates are
 * drawn in (UTC until the browser reads its own), the release, the origin agents connect to, and what the server read
 * for the page: the session and the page's data. */
export const Flags = Schema.Struct({
  language: Language,
  timeZone: Schema.String,
  release: Schema.String,
  origin: Schema.String,
  /** The request carried a session cookie, so the browser reads the session unless the server did; without one it is
   * signed out. The cookie is HttpOnly, so only the server can tell. */
  hasSessionCookie: Schema.Boolean,
  sessionRead: SessionRead,
  preload: Preload,
  /** The stage's default inbox relays (NIP-17, kind 10050), which the identity page offers a person who has none;
   * empty unless the stage sets `SIDEQUEST_DEFAULT_INBOX_RELAYS`. */
  defaultInboxRelays: Schema.Array(Schema.String),
})
export type Flags = typeof Flags.Type

/** The page the document shows, with its own Model. */
export const Page = defineTaggedUnion({
  Home: { home: Pages.Home.Model },
  SignIn: { signIn: Pages.SignIn.Model },
  NewListing: { newListing: Pages.NewListing.Model },
  Listing: { listing: Pages.ListingPage.Model },
  NewRequest: { newRequest: Pages.NewRequest.Model },
  Job: { job: Pages.Job.Model },
  Inbox: { inbox: Pages.Inbox.Model },
  Agents: { agents: Pages.Agents.Model },
  Connect: { connect: Pages.Connect.Model },
  Connections: { connections: Pages.Connections.Model },
  Identity: { identity: Pages.Identity.Model },
  Evidence: { evidence: Pages.Evidence.Model },
  NotFound: {},
})
export type Page = typeof Page.Type

export const Model = Schema.Struct({
  flags: Flags,
  route: AppRoute,
  session: Session,
  /** Who the person is on the marketplace pages: their Nostr signer, once the browser found one. */
  me: Me,
  /** A sign-out that failed, shown under the header until the next page. */
  maybeShellProblem: Schema.Option(Problem),
  page: Page,
})
export type Model = typeof Model.Type
