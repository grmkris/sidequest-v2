import * as Domain from '@alchemy.run/domain'
import { Layer } from 'effect'
import { Listing } from './Directory/Listing.aggregate.ts'
import { Listings, ListingsLive } from './Directory/Listings.projection.ts'
import { Account } from './Identity/Account.aggregate.ts'
import { Agent } from './Identity/Agent.aggregate.ts'
import { Agents, AgentsLive } from './Identity/Agents.projection.ts'
import { WalletClaim } from './Identity/WalletClaim.aggregate.ts'
import { Inbox, InboxLive } from './Inbox/Inbox.projection.ts'
import { BidderJobSummary } from './Job/BidderJobSummary.view.ts'
import { BuyerJobSummary } from './Job/BuyerJobSummary.view.ts'
import { Job } from './Job/Job.aggregate.ts'
import { JobSummary } from './Job/JobSummary.view.ts'
import { OpenJobs, OpenJobsLive } from './Job/OpenJobs.projection.ts'
import { RequestExpiry, RequestExpiryLive } from './Job/RequestExpiry.policy.ts'
import { Room } from './Rooms/Room.aggregate.ts'
import { RoomMessageLog, RoomMessageLogLive } from './Rooms/RoomMessageLog.projection.ts'
import { RoomMessages } from './Rooms/RoomMessages.stream.ts'
import { RoomOpening, RoomOpeningLive } from './Rooms/RoomOpening.policy.ts'

/** Phase 1's model: identity, the directory, the job lifecycle and its rooms, with their views and projections. */
export class Sidequest extends Domain.Model('Sidequest', {
  aggregates: [Account, WalletClaim, Agent, Listing, Job, Room],
  views: [JobSummary, BuyerJobSummary, BidderJobSummary],
  policies: [RoomOpening, RequestExpiry],
  projections: [Agents, Listings, OpenJobs, Inbox, RoomMessageLog],
  streams: [RoomMessages],
}) {}

/**
 * Every policy and projection implementation, as one Layer. It needs the store ports (`AgentStore`, `ListingStore`,
 * `OpenJobStore`, `InboxStore`): D1 on the server, memory in stories.
 */
export const SidequestHandlers = Layer.mergeAll(
  RoomOpeningLive,
  RequestExpiryLive,
  AgentsLive,
  ListingsLive,
  OpenJobsLive,
  InboxLive,
  RoomMessageLogLive,
)
