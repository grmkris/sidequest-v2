import * as DomainCloudflare from '@alchemy.run/cloudflare/Domain'
import { Sidequest, SidequestHandlers } from '@sidequest/domain'
import { Layer } from 'effect'
import { D1AccountNameStore } from './Projections/D1AccountNameStore.ts'
import { D1AgentStore } from './Projections/D1AgentStore.ts'
import { D1InboxStore } from './Projections/D1InboxStore.ts'
import { D1ListingStore } from './Projections/D1ListingStore.ts'
import { D1OpenJobStore } from './Projections/D1OpenJobStore.ts'
import { D1PartyJobStore } from './Projections/D1PartyJobStore.ts'
import { ChainSettlementLive } from './Settlement/ChainSettlementLive.ts'

/** The stores the model's D1 projections write through; they need the database's `SqlClient`. */
export const D1Stores = Layer.mergeAll(
  D1AgentStore,
  D1AccountNameStore,
  D1ListingStore,
  D1OpenJobStore,
  D1PartyJobStore,
  D1InboxStore,
)

/**
 * The model's handlers with what they need: the D1 stores for its projections and the chain for its settlement
 * sagas. Needs the database's `SqlClient` and the `Escrow`.
 */
export const DomainHandlers = SidequestHandlers.pipe(Layer.provide(Layer.mergeAll(D1Stores, ChainSettlementLive)))

/** The model hosted on Durable Objects, its projections writing to D1 and its sagas reading the chain. */
export const DomainLive = Sidequest.layer(DomainHandlers).pipe(Layer.provide(DomainCloudflare.DurableObjects))
