import { Option } from 'effect'
import { Command, Subscription, Update } from 'foldkit'
import { modifyFields } from 'foldkit/struct'
import type { SidequestClient } from './Api.ts'
import { Message } from './Message.ts'
import * as Me from './Me.ts'
import { type Flags, type Model, Page } from './Model.ts'
import { Preload } from './Preload.ts'
import { NavigateInternal } from './Navigation.ts'
import * as Agents from './page/Agents.ts'
import * as Evidence from './page/Evidence.ts'
import * as Home from './page/Home.ts'
import * as Identity from './page/Identity.ts'
import * as Inbox from './page/Inbox.ts'
import * as Job from './page/job/Job.ts'
import * as ListingPage from './page/ListingPage.ts'
import * as NewListing from './page/NewListing.ts'
import * as NewRequest from './page/NewRequest.ts'
import { AppRoute, identityHref, jobRouter, listingRouter } from './route.ts'
import type { Gateway } from './Gateway.ts'
import type { Marks } from './Marks.ts'
import type { Rooms } from './Rooms.ts'
import type { Signers } from './Signer.ts'
import type { Wallet } from './Wallet.ts'

// Which page a route opens, and how each page's Messages and OutMessages fold into the app.

export type Services = SidequestClient | Wallet | Signers | Rooms | Gateway | Marks
type Step = Update.Step<Model, Message, Services>

/** The identity page, which reads nothing from the server: the signer lives in the browser. */
const openIdentity = (flags: Flags, maybeNext: Option.Option<string>): Update.Return<Page, Message, Services> =>
  Update.foldChildInit(Identity.init(flags.language, maybeNext, flags.defaultInboxRelays), {
    toParentModel: (identity) => Page.Identity({ identity }),
    toParentMessage: (message) => Message.GotIdentityMessage({ message }),
  })

/** Send the person to set up a signer, and back to where they are. */
const toIdentity: Step = (model) => ({ model, commands: [NavigateInternal({ href: identityHref(model.route) })] })

/** The page a route opens: from the data the server read for it, or with the Commands that read its data. The pages
 * that act as the person's key start from who the site knows them to be. */
export const openPage = (
  flags: Flags,
  route: AppRoute,
  me: Me.Me,
  preload: Preload,
): Update.Return<Page, Message, Services> =>
  AppRoute.match(route, {
    Home: ({ q }) =>
      Update.foldChildInit(Home.init(q, Preload.guards.Home(preload) ? Option.some(preload) : Option.none()), {
        toParentModel: (home) => Page.Home({ home }),
        toParentMessage: (message) => Message.GotHomeMessage({ message }),
      }),
    NewListing: () => ({ model: Page.NewListing({ newListing: NewListing.init(flags.language, me) }) }),
    Listing: ({ pubkey, slug }) =>
      Update.foldChildInit(
        ListingPage.init(
          flags.language,
          { pubkey, slug },
          me,
          Preload.guards.Listing(preload) ? Option.some(preload) : Option.none(),
        ),
        {
          toParentModel: (listingModel) => Page.Listing({ listing: listingModel }),
          toParentMessage: (message) => Message.GotListingMessage({ message }),
        },
      ),
    NewRequest: () => ({ model: Page.NewRequest({ newRequest: NewRequest.init(flags.language, me) }) }),
    Job: ({ job }) =>
      Update.foldChildInit(
        Job.init(flags.language, job, me, Preload.guards.Job(preload) ? Option.some(preload) : Option.none()),
        {
          toParentModel: (jobModel) => Page.Job({ job: jobModel }),
          toParentMessage: (message) => Message.GotJobMessage({ message }),
        },
      ),
    Inbox: () =>
      Update.foldChildInit(Inbox.init(flags.language, me), {
        toParentModel: (inbox) => Page.Inbox({ inbox }),
        toParentMessage: (message) => Message.GotInboxMessage({ message }),
      }),
    Agents: () =>
      Update.foldChildInit(Agents.init(flags.language, me, flags.maybeGatewayUrl), {
        toParentModel: (agents) => Page.Agents({ agents }),
        toParentMessage: (message) => Message.GotAgentsMessage({ message }),
      }),
    Identity: ({ next }) => openIdentity(flags, next),
    Evidence: () => ({ model: Page.Evidence({ evidence: Evidence.init(flags.language) }) }),
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

export const foldNewListing = Update.foldChild({
  update: NewListing.update,
  read: (model: Model) => (Page.guards.NewListing(model.page) ? Option.some(model.page.newListing) : Option.none()),
  write: (model: Model, nextNewListing: NewListing.Model) =>
    writePage(model, Page.NewListing({ newListing: nextNewListing })),
  toParentMessage: (message) => Message.GotNewListingMessage({ message }),
  foldOutMessage: NewListing.OutMessage.match<Step>({
    Published:
      ({ pubkey, slug }) =>
      (model) => ({ model, commands: [NavigateInternal({ href: listingRouter({ pubkey, slug }) })] }),
    SignerMissing: () => toIdentity,
  }),
})

export const foldListing = Update.foldChild({
  update: ListingPage.update,
  read: (model: Model) => (Page.guards.Listing(model.page) ? Option.some(model.page.listing) : Option.none()),
  write: (model: Model, nextListing: ListingPage.Model) => writePage(model, Page.Listing({ listing: nextListing })),
  toParentMessage: (message) => Message.GotListingMessage({ message }),
  foldOutMessage: ListingPage.OutMessage.match<Step>({ SignerMissing: () => toIdentity }),
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
    SignerMissing: () => toIdentity,
  }),
})

export const readJob = (model: Model): Option.Option<Job.Model> =>
  Page.guards.Job(model.page) ? Option.some(model.page.job) : Option.none()

export const foldJob = Update.foldChild({
  update: Job.update,
  read: readJob,
  write: (model: Model, nextJob: Job.Model) => writePage(model, Page.Job({ job: nextJob })),
  toParentMessage: (message) => Message.GotJobMessage({ message }),
  foldOutMessage: Job.OutMessage.match<Step>({ SignerMissing: () => toIdentity }),
})

/** The pages that act as the person's key learn who the site now knows them to be. */
export const informMe = (model: Model): Model =>
  writePage(
    model,
    Page.match(model.page, {
      NewListing: ({ newListing }) => Page.NewListing({ newListing: modifyFields(newListing, { me: () => model.me }) }),
      Listing: ({ listing }) => Page.Listing({ listing: modifyFields(listing, { me: () => model.me }) }),
      NewRequest: ({ newRequest }) => Page.NewRequest({ newRequest: modifyFields(newRequest, { me: () => model.me }) }),
      Job: ({ job }) => Page.Job({ job: modifyFields(job, { me: () => model.me }) }),
      Home: () => model.page,
      Inbox: () => model.page,
      Agents: () => model.page,
      Identity: () => model.page,
      Evidence: () => model.page,
      NotFound: () => model.page,
    }),
  )

/** Who the person is changed: the site's record of it, the page that acts as it, and any Commands that follow; the
 * inbox and the agents page read what the new key has. */
const withMe = (
  model: Model,
  next: Update.Return<Me.Me, Me.Message, Services>,
): Update.Return<Model, Message, Services> => {
  const informed = informMe(modifyFields(model, { me: () => next.model }))
  const meCommands = Command.mapMessages(next.commands, (message) => Message.GotMeMessage({ message }))
  const reread: Update.Return<Page, Message, Services> = Page.match(informed.page, {
    Inbox: ({ inbox }) =>
      Update.foldChildInit(Inbox.meChanged(inbox, informed.me), {
        toParentModel: (nextInbox) => Page.Inbox({ inbox: nextInbox }),
        toParentMessage: (message) => Message.GotInboxMessage({ message }),
      }),
    Agents: ({ agents }) =>
      Update.foldChildInit(Agents.meChanged(agents, informed.me), {
        toParentModel: (nextAgents) => Page.Agents({ agents: nextAgents }),
        toParentMessage: (message) => Message.GotAgentsMessage({ message }),
      }),
    Home: () => ({ model: informed.page }),
    NewListing: () => ({ model: informed.page }),
    Listing: () => ({ model: informed.page }),
    NewRequest: () => ({ model: informed.page }),
    Job: () => ({ model: informed.page }),
    Identity: () => ({ model: informed.page }),
    Evidence: () => ({ model: informed.page }),
    NotFound: () => ({ model: informed.page }),
  })
  return {
    model: writePage(informed, reread.model),
    commands: [...(meCommands ?? []), ...(reread.commands ?? [])],
  }
}

export const foldMe = (model: Model, message: Me.Message) => withMe(model, Me.update(model.me, message))

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

export const foldIdentity = Update.foldChild({
  update: Identity.update,
  read: (model: Model) => (Page.guards.Identity(model.page) ? Option.some(model.page.identity) : Option.none()),
  write: (model: Model, nextIdentity: Identity.Model) => writePage(model, Page.Identity({ identity: nextIdentity })),
  toParentMessage: (message) => Message.GotIdentityMessage({ message }),
  foldOutMessage: Identity.OutMessage.match<Step>({
    // The identity page reads what the index knows of the key itself, and says so with `StandingRead`.
    SignerReady:
      ({ identity }) =>
      (model) =>
        withMe(model, { model: Me.Me.Ready({ identity, standing: Me.Standing.Reading() }) }),
    SignerForgotten: () => (model) => withMe(model, { model: Me.Me.NoSigner() }),
    StandingRead:
      ({ pubkey, standing }) =>
      (model) =>
        withMe(model, { model: Me.standingRead(model.me, pubkey, standing) }),
  }),
})

export const foldEvidence = Update.foldChild({
  update: Evidence.update,
  read: (model: Model) => (Page.guards.Evidence(model.page) ? Option.some(model.page.evidence) : Option.none()),
  write: (model: Model, nextEvidence: Evidence.Model) => writePage(model, Page.Evidence({ evidence: nextEvidence })),
  toParentMessage: (message) => Message.GotEvidenceMessage({ message }),
})

/** The job page's room polls while its panel is open. */
export const subscriptions = Subscription.lift(Job.subscriptions)<Model, Message>({
  read: readJob,
  toParentMessage: (message) => Message.GotJobMessage({ message }),
})
