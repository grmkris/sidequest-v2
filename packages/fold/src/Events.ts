import type { EventId } from '@sidequest/nostr'
import type {
  DeliveryNoteContent,
  JobAcceptContent,
  JobProposalContent,
  JobRequestContent,
  JobReviewContent,
  ParsedEvent,
  StatementContent,
} from '@sidequest/nostr/vocabulary'
import { type JobEvent, jobOfEvent } from './JobInput.ts'

/** Text order, for ids and other canonical strings. */
export const compareText = (left: string, right: string): number => {
  if (left === right) return 0
  return left < right ? -1 : 1
}

/** Display order: by `created_at`, then id. Never decides anything but the order of a list. */
const byDisplay = <C>(left: ParsedEvent<C>, right: ParsedEvent<C>): number =>
  left.event.created_at - right.event.created_at || compareText(left.event.id, right.event.id)

/** One job's events, each once, sorted for display. `request` is missing when its event is not in the bag. */
export interface JobEvents {
  readonly request: ParsedEvent<JobRequestContent> | undefined
  readonly proposals: ReadonlyArray<ParsedEvent<JobProposalContent>>
  readonly accepts: ReadonlyArray<ParsedEvent<JobAcceptContent>>
  readonly deliveryNotes: ReadonlyArray<ParsedEvent<DeliveryNoteContent>>
  readonly statements: ReadonlyArray<ParsedEvent<StatementContent>>
  readonly reviews: ReadonlyArray<ParsedEvent<JobReviewContent>>
}

/**
 * The events about `job`, deduplicated by event id (an id is the hash of everything signed, so two copies are the same
 * event) and sorted for display. Events about other jobs are dropped.
 */
export const eventsOf = (job: EventId, events: ReadonlyArray<JobEvent>): JobEvents => {
  const unique = new Map<EventId, JobEvent>()
  for (const event of events) if (jobOfEvent(event) === job) unique.set(event.parsed.event.id, event)
  const sorted = {
    request: new Array<ParsedEvent<JobRequestContent>>(),
    proposals: new Array<ParsedEvent<JobProposalContent>>(),
    accepts: new Array<ParsedEvent<JobAcceptContent>>(),
    deliveryNotes: new Array<ParsedEvent<DeliveryNoteContent>>(),
    statements: new Array<ParsedEvent<StatementContent>>(),
    reviews: new Array<ParsedEvent<JobReviewContent>>(),
  }
  for (const event of unique.values()) {
    switch (event.type) {
      case 'request':
        sorted.request.push(event.parsed)
        break
      case 'proposal':
        sorted.proposals.push(event.parsed)
        break
      case 'accept':
        sorted.accepts.push(event.parsed)
        break
      case 'deliveryNote':
        sorted.deliveryNotes.push(event.parsed)
        break
      case 'statement':
        sorted.statements.push(event.parsed)
        break
      case 'review':
        sorted.reviews.push(event.parsed)
        break
    }
  }
  return {
    request: sorted.request[0],
    proposals: sorted.proposals.toSorted(byDisplay),
    accepts: sorted.accepts.toSorted(byDisplay),
    deliveryNotes: sorted.deliveryNotes.toSorted(byDisplay),
    statements: sorted.statements.toSorted(byDisplay),
    reviews: sorted.reviews.toSorted(byDisplay),
  }
}
