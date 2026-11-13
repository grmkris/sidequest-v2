import { Schema } from 'effect'
import { defineMessageUnion } from 'foldkit/message'
import { UrlRequest } from 'foldkit/navigation'
import { Url } from 'foldkit/url'
import * as Me from './Me.ts'
import * as Pages from './Pages.ts'

export const Message = defineMessageUnion({
  ClickedLink: { request: UrlRequest },
  ChangedUrl: { url: Url },
  CompletedNavigate: {},
  CompletedFocusTitle: {},
  CompletedReadTimeZone: { timeZone: Schema.String },
  GotMeMessage: { message: Me.Message },
  GotHomeMessage: { message: Pages.Home.Message },
  GotNewListingMessage: { message: Pages.NewListing.Message },
  GotListingMessage: { message: Pages.ListingPage.Message },
  GotNewRequestMessage: { message: Pages.NewRequest.Message },
  GotJobMessage: { message: Pages.Job.Message },
  GotInboxMessage: { message: Pages.Inbox.Message },
  GotAgentsMessage: { message: Pages.Agents.Message },
  GotIdentityMessage: { message: Pages.Identity.Message },
  GotEvidenceMessage: { message: Pages.Evidence.Message },
})
export type Message = typeof Message.Type
