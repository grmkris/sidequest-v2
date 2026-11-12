import { Option } from 'effect'
import { Update } from 'foldkit'
import { modifyFields } from 'foldkit/struct'
import type { SidequestClient } from './Api.ts'
import { Message } from './Message.ts'
import { type Flags, type Model, Page } from './Model.ts'
import { NavigateInternal, ReplaceInternal } from './Navigation.ts'
import * as Agents from './page/Agents.ts'
import * as Home from './page/Home.ts'
import * as Inbox from './page/Inbox.ts'
import * as Job from './page/job/Job.ts'
import * as ListingPage from './page/ListingPage.ts'
import * as NewListing from './page/NewListing.ts'
import * as NewRequest from './page/NewRequest.ts'
import * as SignIn from './page/SignIn.ts'
import { AppRoute, jobRouter, listingRouter } from './route.ts'
import { addressOf, Session } from './Session.ts'
import type { Wallet } from './Wallet.ts'

// Which page a route opens, and how each page's Messages and OutMessages fold into the app.

export type Services = SidequestClient | Wallet
type Step = Update.Step<Model, Message, Services>

/** The wallet of the signed-in person, which signs their steps on a job. */
/** Whether a page may read what only a signed-in person can: not when the browser is known to be signed out, which
 * would only earn a 401. */
const mayRead = (session: Session): boolean => !Session.guards.SignedOut(session)

const signerOf = (session: Session): Option.Option<string> =>
  Session.guards.SignedIn(session) ? Option.some(addressOf(session.session)) : Option.none()

/** The page a route opens, with the Commands that read its data. */
export const openPage = (flags: Flags, route: AppRoute, session: Session): Update.Return<Page, Message, Services> =>
  AppRoute.match(route, {
    Home: ({ q }) =>
      Update.foldChildInit(Home.init(q), {
        toParentModel: (home) => Page.Home({ home }),
        toParentMessage: (message) => Message.GotHomeMessage({ message }),
      }),
    SignIn: ({ next }) => ({ model: Page.SignIn({ signIn: SignIn.init(next) }) }),
    NewListing: () => ({ model: Page.NewListing({ newListing: NewListing.init(flags.language) }) }),
    Listing: ({ listing }) =>
      Update.foldChildInit(ListingPage.init(flags.language, listing), {
        toParentModel: (listingModel) => Page.Listing({ listing: listingModel }),
        toParentMessage: (message) => Message.GotListingMessage({ message }),
      }),
    NewRequest: () => ({ model: Page.NewRequest({ newRequest: NewRequest.init(flags.language) }) }),
    Job: ({ job }) =>
      Update.foldChildInit(Job.init(flags.language, job, signerOf(session), mayRead(session)), {
        toParentModel: (jobModel) => Page.Job({ job: jobModel }),
        toParentMessage: (message) => Message.GotJobMessage({ message }),
      }),
    Inbox: () =>
      Update.foldChildInit(Inbox.init(flags.language, mayRead(session)), {
        toParentModel: (inbox) => Page.Inbox({ inbox }),
        toParentMessage: (message) => Message.GotInboxMessage({ message }),
      }),
    Agents: () =>
      Update.foldChildInit(Agents.init(flags.language, mayRead(session)), {
        toParentModel: (agents) => Page.Agents({ agents }),
        toParentMessage: (message) => Message.GotAgentsMessage({ message }),
      }),
    NotFound: () => ({ model: Page.NotFound() }),
  })

const writePage = (model: Model, page: Page): Model => modifyFields(model, { page: () => page })

export const foldHome = Update.foldChild({
  update: Home.update,
  read: (model: Model) => (Page.guards.Home(model.page) ? Option.some(model.page.home) : Option.none()),
  write: (model: Model, nextHome: Home.Model) => writePage(model, Page.Home({ home: nextHome })),
  toParentMessage: (message) => Message.GotHomeMessage({ message }),
})

export const foldHomeSearch = Update.foldChild({
  update: Home.searchChanged,
  read: (model: Model) => (Page.guards.Home(model.page) ? Option.some(model.page.home) : Option.none()),
  write: (model: Model, nextHome: Home.Model) => writePage(model, Page.Home({ home: nextHome })),
  toParentMessage: (message) => Message.GotHomeMessage({ message }),
})

export const foldSignIn = (signOut: Step) =>
  Update.foldChild({
    update: SignIn.update,
    read: (model: Model) => (Page.guards.SignIn(model.page) ? Option.some(model.page.signIn) : Option.none()),
    write: (model: Model, nextSignIn: SignIn.Model) => writePage(model, Page.SignIn({ signIn: nextSignIn })),
    toParentMessage: (message) => Message.GotSignInMessage({ message }),
    foldOutMessage: SignIn.OutMessage.match<Step>({
      SignedIn:
        ({ session, next }) =>
        (model) => ({
          model: modifyFields(model, { session: () => Session.SignedIn({ session }) }),
          commands: [ReplaceInternal({ href: next })],
        }),
      RequestedSignOut: () => signOut,
    }),
  })

export const foldNewListing = Update.foldChild({
  update: NewListing.update,
  read: (model: Model) => (Page.guards.NewListing(model.page) ? Option.some(model.page.newListing) : Option.none()),
  write: (model: Model, nextNewListing: NewListing.Model) =>
    writePage(model, Page.NewListing({ newListing: nextNewListing })),
  toParentMessage: (message) => Message.GotNewListingMessage({ message }),
  foldOutMessage: NewListing.OutMessage.match<Step>({
    Published:
      ({ listing }) =>
      (model) => ({ model, commands: [NavigateInternal({ href: listingRouter({ listing }) })] }),
  }),
})

export const foldListing = Update.foldChild({
  update: ListingPage.update,
  read: (model: Model) => (Page.guards.Listing(model.page) ? Option.some(model.page.listing) : Option.none()),
  write: (model: Model, nextListing: ListingPage.Model) => writePage(model, Page.Listing({ listing: nextListing })),
  toParentMessage: (message) => Message.GotListingMessage({ message }),
})

export const foldNewRequest = Update.foldChild({
  update: NewRequest.update,
  read: (model: Model) => (Page.guards.NewRequest(model.page) ? Option.some(model.page.newRequest) : Option.none()),
  write: (model: Model, nextNewRequest: NewRequest.Model) =>
    writePage(model, Page.NewRequest({ newRequest: nextNewRequest })),
  toParentMessage: (message) => Message.GotNewRequestMessage({ message }),
  foldOutMessage: NewRequest.OutMessage.match<Step>({
    Posted:
      ({ job }) =>
      (model) => ({ model, commands: [NavigateInternal({ href: jobRouter({ job }) })] }),
  }),
})

export const readJob = (model: Model): Option.Option<Job.Model> =>
  Page.guards.Job(model.page) ? Option.some(model.page.job) : Option.none()

export const foldJob = Update.foldChild({
  update: Job.update,
  read: readJob,
  write: (model: Model, nextJob: Job.Model) => writePage(model, Page.Job({ job: nextJob })),
  toParentMessage: (message) => Message.GotJobMessage({ message }),
})

/** The job page learns whose wallet signs, once the session is known. */
export const informJobSigner = (model: Model): Model =>
  Option.match(readJob(model), {
    onNone: () => model,
    onSome: (job) => writePage(model, Page.Job({ job: Job.informSigner(job, signerOf(model.session)) })),
  })

export const foldInbox = Update.foldChild({
  update: Inbox.update,
  read: (model: Model) => (Page.guards.Inbox(model.page) ? Option.some(model.page.inbox) : Option.none()),
  write: (model: Model, nextInbox: Inbox.Model) => writePage(model, Page.Inbox({ inbox: nextInbox })),
  toParentMessage: (message) => Message.GotInboxMessage({ message }),
})

export const foldAgents = Update.foldChild({
  update: Agents.update,
  read: (model: Model) => (Page.guards.Agents(model.page) ? Option.some(model.page.agents) : Option.none()),
  write: (model: Model, nextAgents: Agents.Model) => writePage(model, Page.Agents({ agents: nextAgents })),
  toParentMessage: (message) => Message.GotAgentsMessage({ message }),
})
