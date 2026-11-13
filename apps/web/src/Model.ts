import { Schema } from 'effect'
import { defineTaggedUnion } from 'foldkit/schema'
import { Language } from './Language.ts'
import { Me } from './Me.ts'
import { Preload } from './Preload.ts'
import { AppRoute } from './route.ts'
import * as Pages from './Pages.ts'

/** What the server stamps into the page and hydration reads back: the reader's language, the time zone dates are
 * drawn in (UTC until the browser reads its own), the release, the site's origin, what the server read for the page
 * (public data only: the server does not know who the visitor is) and the stage's settings. */
export const Flags = Schema.Struct({
  language: Language,
  timeZone: Schema.String,
  release: Schema.String,
  origin: Schema.String,
  preload: Preload,
  /** The stage's default inbox relays (NIP-17, kind 10050), which the identity page offers a person who has none;
   * empty unless the stage sets `SIDEQUEST_DEFAULT_INBOX_RELAYS`. */
  defaultInboxRelays: Schema.Array(Schema.String),
  /** The stage's agent gateway (`SIDEQUEST_GATEWAY_URL`), whose MCP endpoint the agents page shows; none when the stage
   * has none, and the agents page then says so. The page reaches its operator API through the edge's `/gateway`. */
  maybeGatewayUrl: Schema.OptionFromNullOr(Schema.String),
  /** The site's one public URL (`SIDEQUEST_SITE_URL`) when the stage has a domain; the agents page works only there. */
  maybeSiteUrl: Schema.OptionFromNullOr(Schema.String),
  /** The WebAuthn relying party ID for passkey-derived keys on this page's hostname (`SIDEQUEST_PASSKEY_RP_ID`); none
   * when the stage offers no passkeys, or this hostname is not within it. */
  maybePasskeyRpId: Schema.OptionFromNullOr(Schema.String),
})
export type Flags = typeof Flags.Type

/** The page the document shows, with its own Model. */
export const Page = defineTaggedUnion({
  Home: { home: Pages.Home.Model },
  NewListing: { newListing: Pages.NewListing.Model },
  Listing: { listing: Pages.ListingPage.Model },
  NewRequest: { newRequest: Pages.NewRequest.Model },
  Job: { job: Pages.Job.Model },
  Inbox: { inbox: Pages.Inbox.Model },
  Agents: { agents: Pages.Agents.Model },
  Identity: { identity: Pages.Identity.Model },
  Evidence: { evidence: Pages.Evidence.Model },
  NotFound: {},
})
export type Page = typeof Page.Type

export const Model = Schema.Struct({
  flags: Flags,
  route: AppRoute,
  /** Who the person is on the marketplace pages: their Nostr signer, once the browser found one. */
  me: Me,
  page: Page,
})
export type Model = typeof Model.Type
