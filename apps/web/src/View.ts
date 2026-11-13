import { format } from '@sidequest/i18n'
import { Option } from 'effect'
import type { Html } from 'foldkit'
import { Message } from './Message.ts'
import { type Model, Page } from './Model.ts'
import * as AgentsView from './page/AgentsView.ts'
import type { Model as IdentityModel } from './page/Identity.ts'
import * as Evidence from './page/Evidence.ts'
import * as Home from './page/Home.ts'
import * as IdentityView from './page/IdentityView.ts'
import * as InboxView from './page/InboxView.ts'
import * as JobPage from './page/job/JobPage.ts'
import * as ListingPage from './page/ListingPage.ts'
import * as NewListing from './page/NewListing.ts'
import * as NewRequest from './page/NewRequest.ts'
import { AppRoute, agentsRouter, homeRouter, identityRouter, inboxRouter, newRequestRouter } from './route.ts'
import { Me, Standing } from './Me.ts'
import { shortNpub } from './Names.ts'
import { styled } from './Styled.ts'
import { say } from './Text.ts'
import * as Ui from './Ui.ts'
import * as s from './Ui.styles.ts'
import * as vs from './View.styles.ts'

// The shell every page shares: a skip link, the header with the navigation and the person's Nostr identity, the page,
// the footer.

const navLink = (h: Html.HtmlBuilder<Message>, href: string, label: string, current: boolean) =>
  h.a([h.Href(href), ...(current ? [h.AriaCurrent('page')] : []), ...styled(h, vs.navLink())], [label])

/** Who the person is on the marketplace: their Nostr key, by its name or short npub, or the way to set one up. */
const identityLink = (h: Html.HtmlBuilder<Message>, model: Model) => {
  const language = model.flags.language
  const href = identityRouter({ next: Option.none() })
  const current = AppRoute.guards.Identity(model.route)
  return Me.match(model.me, {
    Detecting: () => navLink(h, href, say(language, 'shell.identity'), current),
    NoSigner: () => navLink(h, href, say(language, 'shell.identity'), current),
    Ready: ({ identity, standing }) =>
      h.a(
        [
          h.Href(href),
          h.Title(identity.pubkey),
          h.AriaLabel(say(language, 'shell.identity')),
          ...(current ? [h.AriaCurrent('page')] : []),
          ...styled(h, vs.navLink()),
        ],
        [
          Option.getOrElse(Standing.guards.Known(standing) ? standing.maybeName : Option.none(), () =>
            shortNpub(identity.pubkey),
          ),
        ],
      ),
  })
}

const sessionArea = (h: Html.HtmlBuilder<Message>, model: Model) =>
  h.div(styled(h, vs.session()), [identityLink(h, model)])

const header = (h: Html.HtmlBuilder<Message>, model: Model) => {
  const language = model.flags.language
  const route = model.route
  return h.header(styled(h, vs.header()), [
    h.div(styled(h, vs.bar()), [
      h.a(
        [h.Href(homeRouter({ q: Option.none() })), h.AriaLabel(say(language, 'shell.home')), ...styled(h, vs.brand())],
        ['Sidequest'],
      ),
      sessionArea(h, model),
    ]),
    h.nav(
      [h.AriaLabel(say(language, 'shell.nav')), ...styled(h, vs.nav())],
      [
        navLink(h, newRequestRouter(), say(language, 'shell.postRequest'), AppRoute.guards.NewRequest(route)),
        navLink(h, inboxRouter(), say(language, 'shell.inbox'), AppRoute.guards.Inbox(route)),
        navLink(h, agentsRouter(), say(language, 'shell.agents'), AppRoute.guards.Agents(route)),
      ],
    ),
  ])
}

const notFound = (h: Html.HtmlBuilder<Message>, model: Model) =>
  h.div(styled(h, s.page()), [
    Ui.pageHead(h, say(model.flags.language, 'notFound.title'), [say(model.flags.language, 'notFound.body')]),
    h.p([], [h.a([h.Href(homeRouter({ q: Option.none() }))], [say(model.flags.language, 'notFound.home')])]),
  ])

/** The person's Nostr identity. */
const identityPage = (h: Html.HtmlBuilder<Message>, identity: IdentityModel) =>
  h.submodel({
    slotId: 'identity',
    model: identity,
    view: IdentityView.view,
    toParentMessage: (message) => Message.GotIdentityMessage({ message }),
  })

const pageView = (h: Html.HtmlBuilder<Message>, model: Model): Html.Html => {
  const language = model.flags.language
  const timeZone = model.flags.timeZone
  return Page.match(model.page, {
    Home: ({ home }) =>
      h.submodel({
        slotId: 'home',
        model: home,
        view: Home.view,
        viewInputs: { language, timeZone },
        toParentMessage: (message) => Message.GotHomeMessage({ message }),
      }),
    NewListing: ({ newListing }) =>
      h.submodel({
        slotId: 'new-listing',
        model: newListing,
        view: NewListing.view,
        toParentMessage: (message) => Message.GotNewListingMessage({ message }),
      }),
    Listing: ({ listing }) =>
      h.submodel({
        slotId: 'listing',
        model: listing,
        view: ListingPage.view,
        toParentMessage: (message) => Message.GotListingMessage({ message }),
      }),
    NewRequest: ({ newRequest }) =>
      h.submodel({
        slotId: 'new-request',
        model: newRequest,
        view: NewRequest.view,
        toParentMessage: (message) => Message.GotNewRequestMessage({ message }),
      }),
    Job: ({ job }) =>
      h.submodel({
        slotId: 'job',
        model: job,
        view: JobPage.view,
        viewInputs: { timeZone, inboxConfigured: model.flags.defaultInboxRelays.length > 0 },
        toParentMessage: (message) => Message.GotJobMessage({ message }),
      }),
    Inbox: ({ inbox }) =>
      h.submodel({
        slotId: 'inbox',
        model: inbox,
        view: InboxView.view,
        viewInputs: { timeZone },
        toParentMessage: (message) => Message.GotInboxMessage({ message }),
      }),
    Agents: ({ agents }) =>
      h.submodel({
        slotId: 'agents',
        model: agents,
        view: AgentsView.view,
        viewInputs: { timeZone },
        toParentMessage: (message) => Message.GotAgentsMessage({ message }),
      }),
    Identity: ({ identity }) => identityPage(h, identity),
    Evidence: ({ evidence }) =>
      h.submodel({
        slotId: 'evidence',
        model: evidence,
        view: Evidence.view,
        viewInputs: { timeZone },
        toParentMessage: (message) => Message.GotEvidenceMessage({ message }),
      }),
    NotFound: () => notFound(h, model),
  })
}

const pageTitle = (model: Model): string => {
  const language = model.flags.language
  return Page.match(model.page, {
    Home: () => say(language, 'home.title'),
    NewListing: () => say(language, 'newListing.title'),
    Listing: ({ listing }) => ListingPage.documentTitle(listing),
    NewRequest: () => say(language, 'request.title'),
    Job: ({ job }) => JobPage.documentTitle(job),
    Inbox: () => say(language, 'inbox.title'),
    Agents: () => say(language, 'agents.title'),
    Identity: () => say(language, 'identity.title'),
    Evidence: () => say(language, 'evidence.title'),
    NotFound: () => say(language, 'notFound.title'),
  })
}

export const view = (model: Model, h: Html.HtmlBuilder<Message>): Html.Document => ({
  title: format(model.flags.language, 'shell.title', { page: pageTitle(model) }),
  lang: model.flags.language,
  body: h.div(styled(h, vs.shell()), [
    h.a([h.Href('#main'), ...styled(h, vs.skip())], [say(model.flags.language, 'shell.skip')]),
    header(h, model),
    h.main([h.Id('main'), ...styled(h, vs.main())], [pageView(h, model)]),
    h.footer(styled(h, vs.footer()), [
      h.p([], [say(model.flags.language, 'shell.testnet')]),
      h.p([], [format(model.flags.language, 'foundation.release', { release: model.flags.release })]),
    ]),
  ]),
})
