import * as DomainCloudflare from '@alchemy.run/cloudflare/Domain'
import { Sidequest, SidequestHandlers } from '@sidequest/domain'
import { MemoryListingStore } from '@sidequest/domain/Directory/ListingStore'
import { MemoryInboxStore } from '@sidequest/domain/Inbox/InboxStore'
import { MemoryOpenJobStore } from '@sidequest/domain/Job/OpenJobStore'
import { Layer } from 'effect'

// Placeholder until the projections' D1 adapters arrive with hosting: no route sends a command yet, so nothing
// reaches these memory stores. Replace each with its D1 implementation before any command is exposed.
const Stores = Layer.mergeAll(MemoryListingStore, MemoryOpenJobStore, MemoryInboxStore)

export const DomainLive = Sidequest.layer(SidequestHandlers.pipe(Layer.provide(Stores))).pipe(
  Layer.provide(DomainCloudflare.DurableObjects),
)
