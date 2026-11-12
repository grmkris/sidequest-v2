import { SessionView } from '@sidequest/protocol'
import { Schema } from 'effect'
import { defineMessageUnion } from 'foldkit/message'
import { UrlRequest } from 'foldkit/navigation'
import { Url } from 'foldkit/url'
import { Problem } from './Problem.ts'
import * as Pages from './Pages.ts'

export const Message = defineMessageUnion({
  ClickedLink: { request: UrlRequest },
  ChangedUrl: { url: Url },
  CompletedNavigate: {},
  CompletedFocusTitle: {},
  CompletedReadTimeZone: { timeZone: Schema.String },
  SucceededReadSession: { session: SessionView },
  FailedReadSession: { problem: Problem },
  ClickedSignOut: {},
  SucceededSignOut: {},
  FailedSignOut: { problem: Problem },
  GotHomeMessage: { message: Pages.Home.Message },
  GotSignInMessage: { message: Pages.SignIn.Message },
  GotNewListingMessage: { message: Pages.NewListing.Message },
  GotListingMessage: { message: Pages.ListingPage.Message },
  GotNewRequestMessage: { message: Pages.NewRequest.Message },
  GotJobMessage: { message: Pages.Job.Message },
  GotInboxMessage: { message: Pages.Inbox.Message },
  GotAgentsMessage: { message: Pages.Agents.Message },
  GotConnectMessage: { message: Pages.Connect.Message },
  GotConnectionsMessage: { message: Pages.Connections.Message },
})
export type Message = typeof Message.Type
