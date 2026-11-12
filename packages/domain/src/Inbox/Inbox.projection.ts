import * as Domain from '@alchemy.run/domain'
import { AccountId, RoomId } from '@sidequest/protocol'
import { Effect, Match, Predicate, Schema } from 'effect'
import { unixSeconds } from '../Authority.ts'
import { Account } from '../Identity/Account.aggregate.ts'
import { ProposalAccepted } from '../Job/AcceptProposal.command.ts'
import { BuyerJobSummary, type BuyerView } from '../Job/BuyerJobSummary.view.ts'
import { DeliveryRecorded } from '../Job/RecordDelivery.command.ts'
import { FundingRecorded } from '../Job/RecordFunding.command.ts'
import { JobSettled } from '../Job/RecordSettlement.command.ts'
import { ChangeRequested } from '../Job/RequestChange.command.ts'
import { ProposalSubmitted } from '../Job/SubmitProposal.command.ts'
import { MessagePosted } from '../Rooms/PostMessage.command.ts'
import { Room } from '../Rooms/Room.aggregate.ts'
import { InboxStore, type InboxKind } from './InboxStore.ts'

type InboxEvent =
  | ProposalSubmitted
  | ChangeRequested
  | ProposalAccepted
  | FundingRecorded
  | DeliveryRecorded
  | JobSettled
  | MessagePosted

const kindOf = (event: InboxEvent): InboxKind =>
  Match.valueTags(event, {
    ProposalSubmitted: () => 'proposal_submitted' as const,
    ChangeRequested: () => 'change_requested' as const,
    ProposalAccepted: () => 'proposal_accepted' as const,
    FundingRecorded: () => 'funding_recorded' as const,
    DeliveryRecorded: () => 'delivery_recorded' as const,
    JobSettled: () => 'job_settled' as const,
    MessagePosted: () => 'message_posted' as const,
  })

const inbox = (account: AccountId | undefined) => (account === undefined ? undefined : Account.ref(account))

/** The buyer and the worker of an awarded job, from the buyer's view of it. */
const parties = {
  buyer: ({ state }: { readonly state: BuyerView | null }) => inbox(state?.agreement?.buyer),
  worker: ({ state }: { readonly state: BuyerView | null }) => inbox(state?.agreement?.worker),
}

/** Every room member but the author. */
const others = {
  buyer: ({ event }: { readonly event: MessagePosted }) =>
    inbox(event.members[0] === event.author ? undefined : event.members[0]),
  counterpart: ({ event }: { readonly event: MessagePosted }) =>
    inbox(event.members[1] === event.author ? undefined : event.members[1]),
}

const isRoom = Schema.is(RoomId)

/**
 * Each account's inbox: an item for every event that concerns it. A new proposal reaches the buyer; a change request
 * and an acceptance reach the bidder; funding, delivery and settlement reach both parties; a room message reaches the
 * other members. Items are written through the {@link InboxStore} port.
 */
export class Inbox extends Domain.Projection('Inbox', {
  from: [BuyerJobSummary, Room],
  key: Account,
  keyOf: {
    ProposalSubmitted: ({ state }) => inbox(state?.request?.buyer),
    ChangeRequested: ({ event }) => inbox(event.bidder),
    ProposalAccepted: ({ event }) => inbox(event.agreement.worker),
    FundingRecorded: parties,
    DeliveryRecorded: parties,
    JobSettled: { buyer: ({ event }) => inbox(event.buyer), worker: ({ event }) => inbox(event.worker) },
    MessagePosted: others,
  },
  on: [
    ProposalSubmitted,
    ChangeRequested,
    ProposalAccepted,
    FundingRecorded,
    DeliveryRecorded,
    JobSettled,
    MessagePosted,
  ],
}) {}

export const InboxLive = Inbox.toLayer(
  Effect.gen(function* () {
    const store = yield* InboxStore
    return (batch) =>
      store.record(
        batch.flatMap(({ key, source, event, envelope, state, position }) => {
          // A job event comes with the buyer's view of the job, a message with its job.
          const job = Predicate.isTagged(event, 'MessagePosted') ? event.job : state?.request?.id
          if (job === undefined) return []
          return [
            {
              account: key.id,
              cursor: position,
              id: `${envelope.stream}:${envelope.seq}`,
              kind: kindOf(event),
              job,
              room: isRoom(source.id) ? source.id : null,
              at: unixSeconds(envelope.at),
            },
          ]
        }),
      )
  }),
)
