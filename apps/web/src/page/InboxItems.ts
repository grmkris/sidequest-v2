import { JobView, type ProposalView } from '@sidequest/fold'
import { Array, Option, Schema } from 'effect'
import type { UnreadOnJob } from '../Rooms.ts'

// What needs the person, as a pure function of the jobs they are a party to (each folded by the index from public
// events and chain facts) and the room messages this browser has not shown them. Nothing here is the server's
// knowledge of the person: the server answers who signed what, the browser decides what needs them.

/** A job the person is a party to: as its buyer (they wrote the request) or a bidder (they proposed), as folded. */
export const InboxJob = Schema.Struct({ role: Schema.Literals(['buyer', 'bidder']), view: JobView })
export type InboxJob = typeof InboxJob.Type

/** What needs the person:
 * - `proposal`: a proposal that stands on their open request;
 * - `accepted`: the buyer accepted their proposal, and has not funded it yet;
 * - `funded`: their proposal was funded, and the work is theirs to deliver by the deadline;
 * - `delivered`: work was delivered on their job, and they may approve or reject until the review window ends;
 * - `rejected`: the delivery was rejected, and the arbitrator may rule until the arbitration window ends;
 * - `review`: the job settled, and they have not reviewed the other side yet;
 * - `messages`: room messages on the job this browser has not shown them. */
export const ItemKind = Schema.Literals([
  'proposal',
  'accepted',
  'funded',
  'delivered',
  'rejected',
  'review',
  'messages',
])
export type ItemKind = typeof ItemKind.Type

/** One thing that needs the person, about one job: `key` names it for the browser's read marks, `maybePerson` is who
 * it is from or about, `maybeAt` the deadline or window end it shows, `count` how many (messages). */
export interface InboxItem {
  readonly key: string
  readonly kind: ItemKind
  readonly job: string
  readonly title: string
  readonly maybePerson: Option.Option<string>
  readonly maybeAt: Option.Option<number>
  readonly count: number
}

const negotiable = (view: JobView) => view.stage === 'open' || view.stage === 'proposed' || view.stage === 'accepted'

const stands = (proposal: ProposalView) =>
  !proposal.superseded && !proposal.withdrawn && !proposal.expired && !proposal.otherBuyer

/** Whose proposal it is: the operator whose agent made it under their grant, else its author. */
const bidderOf = (proposal: ProposalView): string =>
  proposal.by === 'agent' && proposal.operator !== null ? proposal.operator : proposal.author

const itemOf = (
  view: JobView,
  kind: ItemKind,
  key: string,
  extra: Partial<Pick<InboxItem, 'maybePerson' | 'maybeAt' | 'count'>> = {},
): InboxItem => ({
  key: `${kind}:${key}`,
  kind,
  job: view.job,
  title: view.request.content.title,
  maybePerson: Option.none(),
  maybeAt: Option.none(),
  count: 1,
  ...extra,
})

/** Before funding: the proposals on the buyer's open request, or the bidder's accepted proposal. */
const negotiationItems = (me: string, { role, view }: InboxJob): ReadonlyArray<InboxItem> => {
  if (!negotiable(view) || view.request.closedByBuyer) {
    return []
  }
  if (role === 'buyer') {
    return Array.map(
      Array.filter(view.proposals, (proposal) => stands(proposal) && !proposal.accepted),
      (proposal) => itemOf(view, 'proposal', proposal.id, { maybePerson: Option.some(bidderOf(proposal)) }),
    )
  }
  return Array.map(
    Array.filter(view.proposals, (proposal) => bidderOf(proposal) === me && proposal.accepted && stands(proposal)),
    (proposal) => itemOf(view, 'accepted', proposal.id, { maybePerson: Option.some(view.buyer) }),
  )
}

/** Whether `me` is the job's buyer or its funded worker. */
const isParty = (me: string, view: JobView) => view.buyer === me || view.worker === me

/** From funding on: the step that is the person's, or the window that is open for them. */
const moneyItems = (me: string, view: JobView): ReadonlyArray<InboxItem> => {
  const { funding, delivery, rejection } = view
  if (view.stage === 'funded' && funding !== null && view.worker === me) {
    return [
      itemOf(view, 'funded', view.job, {
        maybePerson: Option.some(view.buyer),
        maybeAt: Option.some(funding.fact.deliveryDeadline),
      }),
    ]
  }
  if (view.stage === 'delivered' && delivery !== null && view.buyer === me && view.deadlines.reviewWindowOpen) {
    return [
      itemOf(view, 'delivered', delivery.deliveryHash, {
        maybePerson: Option.fromNullishOr(view.worker),
        maybeAt: Option.some(delivery.reviewEndsAt),
      }),
    ]
  }
  if (view.stage === 'rejected' && rejection !== null && isParty(me, view)) {
    return [itemOf(view, 'rejected', view.job, { maybeAt: Option.some(rejection.arbitrationEndsAt) })]
  }
  if (view.ending !== null && isParty(me, view) && !view.reviews.some((review) => review.author === me)) {
    const other = view.buyer === me ? view.worker : view.buyer
    return [itemOf(view, 'review', view.job, { maybePerson: Option.fromNullishOr(other) })]
  }
  return []
}

/** The unseen room messages on the job. */
const messageItems = (view: JobView, unread: ReadonlyArray<UnreadOnJob>): ReadonlyArray<InboxItem> =>
  Option.match(
    Array.findFirst(unread, (entry) => entry.job === view.job && entry.count > 0),
    {
      onNone: () => [],
      onSome: ({ count }) => [itemOf(view, 'messages', `${view.job}:${count}`, { count })],
    },
  )

/** Everything that needs `me`, job by job in the order the jobs come (newest first), each job's items in the order of
 * its steps. */
export const itemsOf = (
  me: string,
  jobs: ReadonlyArray<InboxJob>,
  unread: ReadonlyArray<UnreadOnJob>,
): ReadonlyArray<InboxItem> =>
  Array.flatMap(jobs, (job) => [
    ...negotiationItems(me, job),
    ...moneyItems(me, job.view),
    ...messageItems(job.view, unread),
  ])
