import * as Domain from '@alchemy.run/domain'
import { Listing } from './Directory/Listing.aggregate.ts'
import { Account } from './Identity/Account.aggregate.ts'
import { Agent } from './Identity/Agent.aggregate.ts'
import { Job } from './Job/Job.aggregate.ts'

/** Phase 1's model: identity, the directory and the job lifecycle. Rooms, views and settlement come in later slices. */
export class Sidequest extends Domain.Model('Sidequest', { aggregates: [Account, Agent, Listing, Job] }) {}
