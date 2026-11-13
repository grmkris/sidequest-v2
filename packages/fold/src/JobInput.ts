import type { EventId, PublicKey } from '@sidequest/nostr'
import type {
  DeliveryNoteContent,
  EvmAccount,
  JobAcceptContent,
  JobProposalContent,
  JobRequestContent,
  JobReviewContent,
  ParsedEvent,
  StatementContent,
} from '@sidequest/nostr/vocabulary'
import type { GrantScope, UnixSeconds } from '@sidequest/protocol'
import type { ChainFact } from './ChainFacts.ts'

/** A parsed, verified Sidequest event about a job, tagged with what it is. */
export type JobEvent =
  | { readonly type: 'request'; readonly parsed: ParsedEvent<JobRequestContent> }
  | { readonly type: 'proposal'; readonly parsed: ParsedEvent<JobProposalContent> }
  | { readonly type: 'accept'; readonly parsed: ParsedEvent<JobAcceptContent> }
  | { readonly type: 'deliveryNote'; readonly parsed: ParsedEvent<DeliveryNoteContent> }
  | { readonly type: 'statement'; readonly parsed: ParsedEvent<StatementContent> }
  | { readonly type: 'review'; readonly parsed: ParsedEvent<JobReviewContent> }

/** A wallet link the index has verified and still holds current: `wallet` belongs to `pubkey`. */
export interface WalletLinkFact {
  readonly wallet: EvmAccount
  readonly pubkey: PublicKey
}

/**
 * A grant the index knows (kind `grant`): `operator`, its signer, lets the key `agent` act for them with `scopes` from
 * `notBefore` until `expiresAt`. `revoked`: a revocation of it that its operator signed is known, whenever it arrived.
 */
export interface GrantFact {
  readonly grant: EventId
  readonly operator: PublicKey
  readonly agent: PublicKey
  readonly scopes: ReadonlyArray<GrantScope>
  readonly notBefore: UnixSeconds
  readonly expiresAt: UnixSeconds
  readonly revoked: boolean
}

/** What the fold reads besides the job: links, grants, chain facts and the time labels are judged at. */
export interface FoldContext {
  /** Every current verified wallet link; only those naming a job's payer or receiver matter to it. */
  readonly walletLinks: ReadonlyArray<WalletLinkFact>
  /** The grants the job's events name (`sq-grant`); others are ignored. See `Grants.ts` for how they count. */
  readonly grants: ReadonlyArray<GrantFact>
  /** Verified chain facts. Facts about other jobs' payments are ignored. */
  readonly chain: ReadonlyArray<ChainFact>
  /** Unix seconds. Only labels read it; it never changes a stage. */
  readonly now: UnixSeconds
}

/** One job's fold: its id (the request event's id) and any bag of events, which may hold other jobs' events too. */
export interface JobInput extends FoldContext {
  readonly job: EventId
  readonly events: ReadonlyArray<JobEvent>
}

/** The job an event is about: a request is its own job, every other event names its job. */
export const jobOfEvent = (event: JobEvent): EventId =>
  event.type === 'request' ? event.parsed.event.id : event.parsed.content.job
