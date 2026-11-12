import * as Domain from '@alchemy.run/domain'
import { Effect, Predicate } from 'effect'
import { system } from '../Actor.ts'
import { CurrentActor } from '../CurrentActor.context.ts'
import { ProposalAccepted } from '../Job/AcceptProposal.command.ts'
import { BuyerJobSummary } from '../Job/BuyerJobSummary.view.ts'
import { ProposalSubmitted } from '../Job/SubmitProposal.command.ts'
import { OpenRoom, roomIdFor } from './OpenRoom.command.ts'
import { Room } from './Room.aggregate.ts'

/**
 * Rooms open by themselves: a negotiation room for the buyer and a bidder when that bidder's first proposal arrives,
 * and the engagement room for the buyer and the worker when the job is awarded. It follows the buyer's view of the job,
 * whose state names the buyer. Room ids derive from the job, kind and bidder, and opening an open room records
 * nothing, so a redelivered event opens each room once.
 */
export class RoomOpening extends Domain.Policy('RoomOpening', {
  from: BuyerJobSummary,
  on: [ProposalSubmitted, ProposalAccepted],
}) {}

export const RoomOpeningLive = RoomOpening.toLayer(
  Effect.gen(function* () {
    const rooms = yield* Room
    const open = (command: OpenRoom) =>
      rooms.send(roomIdFor(command), command).pipe(
        Effect.provideService(CurrentActor, system('RoomOpening')),
        Effect.asVoid,
        // The system sends it, to the id the command itself names: neither rejection can happen.
        Effect.orDie,
      )
    return Effect.fn(function* ({ event, state }) {
      if (Predicate.isTagged(event, 'ProposalAccepted')) {
        const { job, buyer, worker } = event.agreement
        return yield* open(new OpenRoom({ job, kind: 'engagement', buyer, counterpart: worker }))
      }
      const { job, bidder, version } = event.proposal
      // A bidder's later versions find their room open already.
      if (version !== 1 || state?.request == null) return
      yield* open(new OpenRoom({ job, kind: 'negotiation', buyer: state.request.buyer, counterpart: bidder }))
    })
  }),
)
