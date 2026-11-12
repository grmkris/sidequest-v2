import { Schema } from 'effect'
import { defineTaggedUnion } from 'foldkit/schema'
import { Language } from './Language.ts'
import { Problem } from './Problem.ts'
import { AppRoute } from './route.ts'
import { Session } from './Session.ts'
import * as Pages from './Pages.ts'

/** What the server stamps into the page and hydration reads back: the reader's language, the release, and the origin
 * agents connect to. */
export const Flags = Schema.Struct({
  language: Language,
  release: Schema.String,
  origin: Schema.String,
  /** The request carried a session cookie, so the browser reads the session; without one it is signed out. The cookie
   * is HttpOnly, so only the server can tell. */
  hasSessionCookie: Schema.Boolean,
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
  NotFound: {},
})
export type Page = typeof Page.Type

export const Model = Schema.Struct({
  flags: Flags,
  route: AppRoute,
  session: Session,
  /** A sign-out that failed, shown under the header until the next page. */
  maybeShellProblem: Schema.Option(Problem),
  page: Page,
})
export type Model = typeof Model.Type
