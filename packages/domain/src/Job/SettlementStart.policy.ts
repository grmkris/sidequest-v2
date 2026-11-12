import * as Domain from '@alchemy.run/domain'
import { Effect } from 'effect'
import { ProposalAccepted } from './AcceptProposal.command.ts'
import { Job } from './Job.aggregate.ts'
import { SettleJob } from './SettleJob.saga.ts'

/** An awarded job is settled through its escrow: its settlement saga starts with the agreement. Starting it again is the same run. */
export class SettlementStart extends Domain.Policy('SettlementStart', { from: Job, on: [ProposalAccepted] }) {}

export const SettlementStartLive = SettlementStart.toLayer(
  Effect.gen(function* () {
    const sagas = yield* SettleJob
    return ({ source, event }) => Effect.asVoid(sagas.start(source, { agreement: event.agreement }))
  }),
)
