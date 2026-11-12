import * as Domain from '@alchemy.run/domain'
import { Layer } from 'effect'
import { Listing } from './Directory/Listing.aggregate.ts'
import { Listings, ListingsLive } from './Directory/Listings.projection.ts'
import { Account } from './Identity/Account.aggregate.ts'
import { AccountNames, AccountNamesLive } from './Identity/AccountNames.projection.ts'
import { Agent } from './Identity/Agent.aggregate.ts'
import { Agents, AgentsLive } from './Identity/Agents.projection.ts'
import { WalletClaim } from './Identity/WalletClaim.aggregate.ts'
import { Inbox, InboxLive } from './Inbox/Inbox.projection.ts'
import { BidderJobSummary } from './Job/BidderJobSummary.view.ts'
import { BuyerJobSummary } from './Job/BuyerJobSummary.view.ts'
import { Job } from './Job/Job.aggregate.ts'
import { JobSummary } from './Job/JobSummary.view.ts'
import { OpenJobs, OpenJobsLive } from './Job/OpenJobs.projection.ts'
import { PartyJobs, PartyJobsLive } from './Job/PartyJobs.projection.ts'
import { ConfirmSubmission, ConfirmSubmissionLive } from './Job/ConfirmSubmission.saga.ts'
import { RequestExpiry, RequestExpiryLive } from './Job/RequestExpiry.policy.ts'
import { SettleJob, SettleJobLive } from './Job/SettleJob.saga.ts'
import { SettlementStart, SettlementStartLive } from './Job/SettlementStart.policy.ts'
import { Room } from './Rooms/Room.aggregate.ts'
import { RoomMessageLog, RoomMessageLogLive } from './Rooms/RoomMessageLog.projection.ts'
import { RoomMessages } from './Rooms/RoomMessages.stream.ts'
import { RoomOpening, RoomOpeningLive } from './Rooms/RoomOpening.policy.ts'
import { RoomPauses } from './Rooms/RoomPauses.view.ts'

/**
 * Phase 1's model: identity, the directory, the job lifecycle and its rooms, with their views and projections, and
 * the saga that settles each awarded job through its escrow.
 */
export class Sidequest extends Domain.Model('Sidequest', {
  aggregates: [Account, WalletClaim, Agent, Listing, Job, Room],
  views: [JobSummary, BuyerJobSummary, BidderJobSummary, RoomPauses],
  policies: [RoomOpening, RequestExpiry, SettlementStart],
  projections: [Agents, AccountNames, Listings, OpenJobs, PartyJobs, Inbox, RoomMessageLog],
  streams: [RoomMessages],
  sagas: [SettleJob, ConfirmSubmission],
}) {}

/**
 * Every policy, saga and projection implementation, as one Layer. It needs the store ports (`AgentStore`,
 * `AccountNameStore`, `ListingStore`, `OpenJobStore`, `PartyJobStore`, `InboxStore`) and the `Settlement` external system: D1 and the chain on the server,
 * memory and answered calls in stories.
 */
export const SidequestHandlers = Layer.mergeAll(
  RoomOpeningLive,
  RequestExpiryLive,
  SettlementStartLive,
  SettleJobLive,
  ConfirmSubmissionLive,
  AgentsLive,
  AccountNamesLive,
  ListingsLive,
  OpenJobsLive,
  PartyJobsLive,
  InboxLive,
  RoomMessageLogLive,
)
