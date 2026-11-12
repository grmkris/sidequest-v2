import { Effect, Option } from 'effect'
import { Command, type Runtime, Subscription, type Update } from 'foldkit'
import { modifyFields } from 'foldkit/struct'
import type { Url } from 'foldkit/url'
import { SidequestClient } from './Api.ts'
import { Message } from './Message.ts'
import { Flags, Model } from './Model.ts'
import { FocusTitle, followLink, NavigateInternal } from './Navigation.ts'
import * as Job from './page/job/Job.ts'
import {
  foldAgents,
  foldHome,
  foldHomeSearch,
  foldInbox,
  foldJob,
  foldListing,
  foldNewListing,
  foldNewRequest,
  foldSignIn,
  informJobSigner,
  openPage,
  readJob,
  type Services,
} from './Page.ts'
import { Problem, problemOf } from './Problem.ts'
import { AppRoute, homeRouter, routeFromUrl } from './route.ts'
import { Session } from './Session.ts'

export { Flags, Message, Model }

// COMMAND

const ReadSession = Command.define('ReadSession', {
  messages: [Message.SucceededReadSession, Message.FailedReadSession],
  execute: Effect.gen(function* () {
    const api = yield* (yield* SidequestClient).api
    const session = yield* api.session.current()
    return Message.SucceededReadSession({ session })
  }).pipe(Effect.catch((error) => Effect.succeed(Message.FailedReadSession({ problem: problemOf(error) })))),
})

export const SignOut = Command.define('SignOut', {
  messages: [Message.SucceededSignOut, Message.FailedSignOut],
  execute: Effect.gen(function* () {
    const api = yield* (yield* SidequestClient).api
    yield* api.session.signOut()
    return Message.SucceededSignOut()
  }).pipe(Effect.catch((error) => Effect.succeed(Message.FailedSignOut({ problem: problemOf(error) })))),
})

// INIT

type UpdateReturn = Update.Return<Model, Message, Services>

/** The page the address names, and the session read in the browser. The server renders the same page without data, so
 * hydration adopts it as it is. */
export const init: Runtime.RoutingApplicationInit<Model, Message, Flags, Services> = (flags: Flags, url: Url) => {
  const route = routeFromUrl(url)
  const session = flags.hasSessionCookie ? Session.Checking() : Session.SignedOut()
  const opened = openPage(flags, route, session)
  return {
    model: { flags, route, session, maybeShellProblem: Option.none(), page: opened.model },
    commands: [...(flags.hasSessionCookie ? [ReadSession()] : []), ...(opened.commands ?? [])],
  }
}

// UPDATE

const signOut: Update.Step<Model, Message, Services> = (model) => {
  const current = model.session
  return Session.guards.SignedIn(current)
    ? {
        model: modifyFields(model, { session: () => Session.SigningOut({ session: current.session }) }),
        commands: [SignOut()],
      }
    : { model }
}

const changedUrl = (model: Model, url: Url): UpdateReturn => {
  const route = routeFromUrl(url)
  if (AppRoute.guards.Home(model.route) && AppRoute.guards.Home(route)) {
    return foldHomeSearch(modifyFields(model, { route: () => route }), route.q)
  }
  const opened = openPage(model.flags, route, model.session)
  return {
    model: modifyFields(model, {
      route: () => route,
      page: () => opened.model,
      maybeShellProblem: () => Option.none(),
    }),
    commands: [...(opened.commands ?? []), FocusTitle()],
  }
}

const sessionRead = (model: Model, session: Session): UpdateReturn => ({
  model: informJobSigner(modifyFields(model, { session: () => session })),
})

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    ClickedLink: ({ request }) => ({ model, commands: [followLink(request)] }),
    ChangedUrl: ({ url }) => changedUrl(model, url),
    CompletedNavigate: () => ({ model }),
    CompletedFocusTitle: () => ({ model }),
    SucceededReadSession: ({ session }) => sessionRead(model, Session.SignedIn({ session })),
    FailedReadSession: ({ problem }) =>
      sessionRead(model, Problem.guards.NotSignedIn(problem) ? Session.SignedOut() : Session.Unknown({ problem })),
    ClickedSignOut: () => signOut(model),
    SucceededSignOut: () => ({
      model: informJobSigner(modifyFields(model, { session: () => Session.SignedOut() })),
      commands: [NavigateInternal({ href: homeRouter({ q: Option.none() }) })],
    }),
    FailedSignOut: ({ problem }) => ({
      model: modifyFields(model, {
        session: (session) =>
          Session.guards.SigningOut(session) ? Session.SignedIn({ session: session.session }) : session,
        maybeShellProblem: () => Option.some(problem),
      }),
    }),
    GotHomeMessage: ({ message: homeMessage }) => foldHome(model, homeMessage),
    GotSignInMessage: ({ message: signInMessage }) => foldSignIn(signOut)(model, signInMessage),
    GotNewListingMessage: ({ message: newListingMessage }) => foldNewListing(model, newListingMessage),
    GotListingMessage: ({ message: listingMessage }) => foldListing(model, listingMessage),
    GotNewRequestMessage: ({ message: newRequestMessage }) => foldNewRequest(model, newRequestMessage),
    GotJobMessage: ({ message: jobMessage }) => foldJob(model, jobMessage),
    GotInboxMessage: ({ message: inboxMessage }) => foldInbox(model, inboxMessage),
    GotAgentsMessage: ({ message: agentsMessage }) => foldAgents(model, agentsMessage),
  })

// SUBSCRIPTION

/** The job page's room follows new messages while the job page is open. */
export const subscriptions = Subscription.lift(Job.subscriptions)<Model, Message>({
  read: readJob,
  toParentMessage: (message) => Message.GotJobMessage({ message }),
})
