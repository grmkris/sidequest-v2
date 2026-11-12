import * as DomainCloudflare from '@alchemy.run/cloudflare/Domain'
import { Sidequest, SidequestHandlers } from '@sidequest/domain'
import { Layer } from 'effect'
import { D1InboxStore } from './Projections/D1InboxStore.ts'
import { D1ListingStore } from './Projections/D1ListingStore.ts'
import { D1OpenJobStore } from './Projections/D1OpenJobStore.ts'

/** The stores the model's D1 projections write through; they need the database's `SqlClient`. */
export const D1Stores = Layer.mergeAll(D1ListingStore, D1OpenJobStore, D1InboxStore)

/** The model hosted on Durable Objects, its projections writing to D1. */
export const DomainLive = Sidequest.layer(SidequestHandlers.pipe(Layer.provide(D1Stores))).pipe(
  Layer.provide(DomainCloudflare.DurableObjects),
)
