import { Effect } from 'effect'
import { Command, type Runtime, type Update } from 'foldkit'
import { modifyFields } from 'foldkit/struct'
import type { Url } from 'foldkit/url'
import { Message } from './Message.ts'
import { Flags, Model } from './Model.ts'
import { FocusTitle, followLink } from './Navigation.ts'
import { DetectMe, Me } from './Me.ts'
import { Preload } from './Preload.ts'
import {
  foldAgents,
  foldHome,
  foldHomeSearch,
  foldEvidence,
  foldIdentity,
  foldInbox,
  foldJob,
  foldListing,
  foldMe,
  foldNewListing,
  foldNewRequest,
  openPage,
  type Services,
  subscriptions,
} from './Page.ts'
import { AppRoute, routeFromUrl } from './route.ts'

export { Flags, Message, Model, subscriptions }

// COMMAND

/** The browser's own time zone, which dates are drawn in once the page has hydrated. */
const ReadTimeZone = Command.define('ReadTimeZone', {
  messages: [Message.CompletedReadTimeZone],
  execute: Effect.sync(() =>
    Message.CompletedReadTimeZone({ timeZone: new Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' }),
  ),
})

// INIT

type UpdateReturn = Update.Return<Model, Message, Services>

/** The page the address names with the data the server read for it. The server renders from the same Flags, so
 * hydration adopts its HTML as it is and reads only what the server did not: the browser's time zone, and the page's
 * data when the server's read failed. The person is their Nostr signer, which lives in the browser alone, so the server
 * renders it as being looked for and the browser then looks: the server never knows who the visitor is. */
export const init: Runtime.RoutingApplicationInit<Model, Message, Flags, Services> = (flags: Flags, url: Url) => {
  const route = routeFromUrl(url)
  const me = Me.Detecting()
  const opened = openPage(flags, route, me, flags.preload)
  return {
    model: { flags, route, me, page: opened.model },
    commands: [
      ReadTimeZone(),
      Command.mapMessage(DetectMe(), (message) => Message.GotMeMessage({ message })),
      ...(opened.commands ?? []),
    ],
  }
}

// UPDATE

const changedUrl = (model: Model, url: Url): UpdateReturn => {
  const route = routeFromUrl(url)
  if (AppRoute.guards.Home(model.route) && AppRoute.guards.Home(route)) {
    return foldHomeSearch(modifyFields(model, { route: () => route }), route.q)
  }
  const opened = openPage(model.flags, route, model.me, Preload.Nothing())
  return {
    model: modifyFields(model, { route: () => route, page: () => opened.model }),
    commands: [...(opened.commands ?? []), FocusTitle()],
  }
}

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    ClickedLink: ({ request }) => ({ model, commands: [followLink(request)] }),
    ChangedUrl: ({ url }) => changedUrl(model, url),
    CompletedNavigate: () => ({ model }),
    CompletedFocusTitle: () => ({ model }),
    CompletedReadTimeZone: ({ timeZone }) => ({
      model: modifyFields(model, { flags: (flags) => modifyFields(flags, { timeZone: () => timeZone }) }),
    }),
    GotMeMessage: ({ message: meMessage }) => foldMe(model, meMessage),
    GotHomeMessage: ({ message: homeMessage }) => foldHome(model, homeMessage),
    GotNewListingMessage: ({ message: newListingMessage }) => foldNewListing(model, newListingMessage),
    GotListingMessage: ({ message: listingMessage }) => foldListing(model, listingMessage),
    GotNewRequestMessage: ({ message: newRequestMessage }) => foldNewRequest(model, newRequestMessage),
    GotJobMessage: ({ message: jobMessage }) => foldJob(model, jobMessage),
    GotInboxMessage: ({ message: inboxMessage }) => foldInbox(model, inboxMessage),
    GotAgentsMessage: ({ message: agentsMessage }) => foldAgents(model, agentsMessage),
    GotIdentityMessage: ({ message: identityMessage }) => foldIdentity(model, identityMessage),
    GotEvidenceMessage: ({ message: evidenceMessage }) => foldEvidence(model, evidenceMessage),
  })
