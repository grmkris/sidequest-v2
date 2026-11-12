import * as Domain from '@alchemy.run/domain'
import { PublishListing } from './Directory/PublishListing.command.ts'
import { UpdateListing } from './Directory/UpdateListing.command.ts'
import { WithdrawListing } from './Directory/WithdrawListing.command.ts'
import { GrantAgent } from './Identity/GrantAgent.command.ts'
import { RegisterAgent } from './Identity/RegisterAgent.command.ts'
import { RevokeGrant } from './Identity/RevokeGrant.command.ts'
import { AcceptProposal } from './Job/AcceptProposal.command.ts'
import { BidderJobSummary } from './Job/BidderJobSummary.view.ts'
import { BuyerJobSummary } from './Job/BuyerJobSummary.view.ts'
import { CancelRequest } from './Job/CancelRequest.command.ts'
import { JobSummary } from './Job/JobSummary.view.ts'
import { LeaveReview } from './Job/LeaveReview.command.ts'
import { PostRequest } from './Job/PostRequest.command.ts'
import { RejectDelivery } from './Job/RejectDelivery.command.ts'
import { RequestChange } from './Job/RequestChange.command.ts'
import { SubmitDelivery } from './Job/SubmitDelivery.command.ts'
import { SubmitProposal } from './Job/SubmitProposal.command.ts'
import { PauseAgents } from './Rooms/PauseAgents.command.ts'
import { PostMessage } from './Rooms/PostMessage.command.ts'
import { ResumeAgents } from './Rooms/ResumeAgents.command.ts'
import { RoomMessages } from './Rooms/RoomMessages.stream.ts'

/**
 * What people (and, later, their agents) may reach: the commands of the hire up to the chain, and the per-audience
 * reads. It holds no `Record*` command, no `ExpireRequest` or `OpenRoom`, and none of sign-in's wallet commands:
 * those are the system's, sent only by policies, sign-in and the settlement saga, so no client of this Api can send
 * one. Each command's `decide` and each read's `validate` judges who is asking.
 */
export class PeopleApi extends Domain.Api(
  'PeopleApi',
  RegisterAgent,
  GrantAgent,
  RevokeGrant,
  PublishListing,
  UpdateListing,
  WithdrawListing,
  PostRequest,
  SubmitProposal,
  RequestChange,
  AcceptProposal,
  CancelRequest,
  SubmitDelivery,
  RejectDelivery,
  LeaveReview,
  PostMessage,
  PauseAgents,
  ResumeAgents,
  JobSummary,
  BuyerJobSummary,
  BidderJobSummary,
  RoomMessages,
) {}
