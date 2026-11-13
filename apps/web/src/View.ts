import { format } from '@sidequest/i18n'
import { Option } from 'effect'
import type { Html } from 'foldkit'
import { Message } from './Message.ts'
import { type Model, Page } from './Model.ts'
import * as AgentsView from './page/AgentsView.ts'
import * as ConnectionsView from './page/ConnectionsView.ts'
import * as ConnectView from './page/ConnectView.ts'
import type { Model as ConnectModel } from './page/Connect.ts'
import type { Model as ConnectionsModel } from './page/Connections.ts'
import type { Model as IdentityModel } from './page/Identity.ts'
import * as Home from './page/Home.ts'
import * as IdentityView from './page/IdentityView.ts'
import * as Inbox from './page/Inbox.ts'
import * as JobPage from './page/job/JobPage.ts'
import * as ListingPage from './page/ListingPage.ts'
import * as NewListing from './page/NewListing.ts'
import * as NewRequest from './page/NewRequest.ts'
import * as SignIn from './page/SignIn.ts'
import {
  AppRoute,
  agentsRouter,
  homeRouter,
  identityRouter,
  inboxRouter,
  newRequestRouter,
  signInHref,
} from './route.ts'
import { accountOf, addressOf, Session } from './Session.ts'
import { styled } from './Styled.ts'
import { say, shortHex } from './Text.ts'
import * as Ui from './Ui.ts'
import * as s from './Ui.styles.ts'
import * as vs from './View.styles.ts'

// The shell every page shares: a skip link, the header with the navigation and the session, the page, the footer.

const navLink = (h: Html.HtmlBuilder<Message>, href: string, label: string, current: boolean) =>
  h.a([h.Href(href), ...(current ? [h.AriaCurrent('page')] : []), ...styled(h, vs.navLink())], [label])

const sessionArea = (h: Html.HtmlBuilder<Message>, model: Model) => {
  const language = model.flags.language
  return h.div(styled(h, vs.session()), [
    navLink(h, identityRouter(), say(language, 'shell.identity'), AppRoute.guards.Identity(model.route)),
    Session.match(model.session, {
      Checking: () => h.span(styled(h, vs.sessionNote()), [say(language, 'shell.checking')]),
      SignedOut: () =>
        navLink(h, signInHref(model.route), say(language, 'shell.signIn'), AppRoute.guards.SignIn(model.route)),
      Unknown: () =>
        navLink(h, signInHref(model.route), say(language, 'shell.signIn'), AppRoute.guards.SignIn(model.route)),
      SignedIn: ({ session }) =>
        h.div(styled(h, vs.account()), [
          h.span(
            [h.Title(addressOf(session)), ...styled(h, vs.sessionNote())],
            [format(language, 'shell.account', { address: shortHex(addressOf(session)) })],
          ),
          Ui.linkButton(h, say(language, 'shell.signOut'), Message.ClickedSignOut()),
        ]),
      SigningOut: () => h.span(styled(h, vs.sessionNote()), [say(language, 'shell.signingOut')]),
    }),
  ])
}

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

/** The consent page an MCP client's authorization request waits on. */
const connectPage = (h: Html.HtmlBuilder<Message>, connect: ConnectModel, session: Session, timeZone: string) =>
  h.submodel({
    slotId: 'connect',
    model: connect,
    view: ConnectView.view,
    viewInputs: { session, timeZone },
    toParentMessage: (message) => Message.GotConnectMessage({ message }),
  })

/** The apps connected to the person's agents. */
const connectionsPage = (
  h: Html.HtmlBuilder<Message>,
  connections: ConnectionsModel,
  session: Session,
  timeZone: string,
) =>
  h.submodel({
    slotId: 'connections',
    model: connections,
    view: ConnectionsView.view,
    viewInputs: { session, timeZone },
    toParentMessage: (message) => Message.GotConnectionsMessage({ message }),
  })

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
  const session = model.session
  return Page.match(model.page, {
    Home: ({ home }) =>
      h.submodel({
        slotId: 'home',
        model: home,
        view: Home.view,
        viewInputs: { language, timeZone },
        toParentMessage: (message) => Message.GotHomeMessage({ message }),
      }),
    SignIn: ({ signIn }) =>
      h.submodel({
        slotId: 'sign-in',
        model: signIn,
        view: SignIn.view,
        viewInputs: { language, session },
        toParentMessage: (message) => Message.GotSignInMessage({ message }),
      }),
    NewListing: ({ newListing }) =>
      h.submodel({
        slotId: 'new-listing',
        model: newListing,
        view: NewListing.view,
        viewInputs: { session },
        toParentMessage: (message) => Message.GotNewListingMessage({ message }),
      }),
    Listing: ({ listing }) =>
      h.submodel({
        slotId: 'listing',
        model: listing,
        view: ListingPage.view,
        viewInputs: { maybeAccount: accountOf(session) },
        toParentMessage: (message) => Message.GotListingMessage({ message }),
      }),
    NewRequest: ({ newRequest }) =>
      h.submodel({
        slotId: 'new-request',
        model: newRequest,
        view: NewRequest.view,
        viewInputs: { session },
        toParentMessage: (message) => Message.GotNewRequestMessage({ message }),
      }),
    Job: ({ job }) =>
      h.submodel({
        slotId: 'job',
        model: job,
        view: JobPage.view,
        viewInputs: { session, me: accountOf(session), timeZone },
        toParentMessage: (message) => Message.GotJobMessage({ message }),
      }),
    Inbox: ({ inbox }) =>
      h.submodel({
        slotId: 'inbox',
        model: inbox,
        view: Inbox.view,
        viewInputs: { session, timeZone },
        toParentMessage: (message) => Message.GotInboxMessage({ message }),
      }),
    Agents: ({ agents }) =>
      h.submodel({
        slotId: 'agents',
        model: agents,
        view: AgentsView.view,
        viewInputs: { session, origin: model.flags.origin, timeZone },
        toParentMessage: (message) => Message.GotAgentsMessage({ message }),
      }),
    Connect: ({ connect }) => connectPage(h, connect, session, timeZone),
    Connections: ({ connections }) => connectionsPage(h, connections, session, timeZone),
    Identity: ({ identity }) => identityPage(h, identity),
    NotFound: () => notFound(h, model),
  })
}

const pageTitle = (model: Model): string => {
  const language = model.flags.language
  return Page.match(model.page, {
    Home: () => say(language, 'home.title'),
    SignIn: () => say(language, 'signIn.title'),
    NewListing: () => say(language, 'newListing.title'),
    Listing: ({ listing }) => ListingPage.documentTitle(listing),
    NewRequest: () => say(language, 'request.title'),
    Job: ({ job }) => JobPage.documentTitle(job),
    Inbox: () => say(language, 'inbox.title'),
    Agents: () => say(language, 'agents.title'),
    Connect: () => say(language, 'connect.title'),
    Connections: () => say(language, 'connections.title'),
    Identity: () => say(language, 'identity.title'),
    NotFound: () => say(language, 'notFound.title'),
  })
}

export const view = (model: Model, h: Html.HtmlBuilder<Message>): Html.Document => ({
  title: format(model.flags.language, 'shell.title', { page: pageTitle(model) }),
  lang: model.flags.language,
  body: h.div(styled(h, vs.shell()), [
    h.a([h.Href('#main'), ...styled(h, vs.skip())], [say(model.flags.language, 'shell.skip')]),
    header(h, model),
    h.main(
      [h.Id('main'), ...styled(h, vs.main())],
      [
        Option.match(model.maybeShellProblem, {
          onNone: () => h.empty,
          onSome: (problem) => Ui.problemNotice(h, model.flags.language, problem),
        }),
        pageView(h, model),
      ],
    ),
    h.footer(styled(h, vs.footer()), [
      h.p([], [say(model.flags.language, 'shell.testnet')]),
      h.p([], [format(model.flags.language, 'foundation.release', { release: model.flags.release })]),
    ]),
  ]),
})
