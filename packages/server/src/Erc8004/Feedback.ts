import type { JobView, ReviewView } from '@sidequest/fold'
import type { NostrEvent } from '@sidequest/nostr'
import {
  type AccountRef,
  canonicalize,
  type Erc8004Registration,
  SidequestFeedbackEntry,
  type SidequestFeedbackEvidence,
  type SidequestFeedbackFile,
  type SidequestFeedbackItem,
} from '@sidequest/protocol'
import { Option, Result, Schema } from 'effect'
import { keccak256, stringToHex } from 'viem'
import { feedbackPath } from './Registration.ts'

// A key's counted reviews as ERC-8004 feedback (ADR-0007, decision 6). Pure: the job folds, the signed events and the
// transactions go in; the file comes out. Which reviews count is the fold's rule (settled, from a key linked to one side
// of the escrow, one per side); this adds that the review's subject must be the key linked to the other side, and
// maps it to the key: the subject itself, or the agent whose proposal the chain funded under its operator's grant.

/** The ERC-8004 rating tag the specification lists for a 0–100 quality rating, and Sidequest's own. */
export const feedbackTags = { tag1: 'starred', tag2: 'sidequest' } as const

/** A star rating (1–5) as `starred`'s 0–100. */
export const starredValue = (rating: number) => rating * 20

/** Where one entry is served alone: the `feedbackURI` posted on chain with it. */
export const entryPath = (pubkey: string, review: string) => `${feedbackPath(pubkey)}/${review}`

/** An ISO 8601 time with whole seconds, as the specification's example writes `createdAt`. */
export const isoSeconds = (unix: number) => new Date(unix * 1000).toISOString().replace(/\.\d{3}Z$/u, 'Z')

const encodeEntry = Schema.encodeSync(SidequestFeedbackEntry)

/** An entry's document, the bytes `feedbackHash` is the `keccak256` of: its RFC 8785 canonical JSON. */
export const entryDocument = (entry: SidequestFeedbackEntry): Result.Result<string, unknown> =>
  canonicalize(encodeEntry(entry))

/** The `feedbackHash` of an entry's document. */
export const entryHash = (document: string) => keccak256(stringToHex(document))

/** What the file needs about one settled job, besides its fold: the signed events and transactions it cites. */
export interface JobEvidence {
  readonly view: JobView
  /** Stored events by id: the reviews, the wallet links and, for an agent's job, the funded proposal and grant. */
  readonly events: ReadonlyMap<string, NostrEvent>
  /** The current verified link event of each of the escrow's two wallets, by account in lowercase. */
  readonly linkOf: ReadonlyMap<string, string>
  readonly fundingTx: string
  readonly settlementTx: string
}

/** The address part of a CAIP-10 account. */
const addressOf = (account: string) => account.slice(account.lastIndexOf(':') + 1)
const chainIdOf = (account: string) => account.split(':')[1] ?? ''

/** Whose the file is: the key, the stage's operator contract, its registrations and where it is served. */
export interface FeedbackScope {
  readonly subject: string
  readonly operator: AccountRef
  readonly registrations: ReadonlyArray<Erc8004Registration>
  readonly origin: string
}

/** Whether the key is the agent that signed the job's funded proposal under its operator's grant. */
const fundedByAgent = (view: JobView, key: string) => {
  const funded = view.funding?.proposal
  const proposal = view.proposals.find((candidate) => candidate.id === funded)
  return proposal !== undefined && proposal.by === 'agent' && proposal.author === key && proposal.grant !== null
    ? Option.some(proposal)
    : Option.none()
}

/** The review's signed event and the two link events, if the reviewer and the subject hold the escrow's two sides. */
const partiesOf = (job: JobEvidence, review: ReviewView) => {
  const funding = job.view.funding
  if (funding === null || review.status !== 'counted' || review.side === null) return Option.none()
  const { payer, receiver } = funding.fact
  const [clientAccount, otherAccount] = review.side === 'payer' ? [payer, receiver] : [receiver, payer]
  const reviewerLink = job.events.get(job.linkOf.get(clientAccount.toLowerCase()) ?? '')
  const subjectLink = job.events.get(job.linkOf.get(otherAccount.toLowerCase()) ?? '')
  const reviewEvent = job.events.get(review.id)
  // The subject must be the key holding the other side's wallet, and the reviewer the key holding theirs.
  const held = subjectLink?.pubkey === review.content.subject && reviewerLink?.pubkey === review.author
  return held && reviewEvent !== undefined && reviewerLink !== undefined && subjectLink !== undefined
    ? Option.some({ clientAccount, payer, receiver, reviewEvent, reviewerLink, subjectLink })
    : Option.none()
}

/**
 * Why the review is about the key: it is the review's subject (no more evidence), or the key is the agent whose funded
 * proposal, under the subject's grant, the payer's review is about (the proposal and the grant). `None` otherwise.
 */
const authorityOf = (scope: FeedbackScope, job: JobEvidence, review: ReviewView) => {
  if (review.content.subject === scope.subject) return Option.some({})
  if (review.side !== 'payer' || review.content.subject !== job.view.worker) return Option.none()
  return Option.flatMap(fundedByAgent(job.view, scope.subject), (proposal) =>
    Option.all({
      proposal: Option.fromUndefinedOr(job.events.get(proposal.id)),
      grant: Option.fromUndefinedOr(job.events.get(proposal.grant ?? '')),
    }),
  )
}

/** The entry, from the review's parties and the key's authority. */
const entryWith = (
  scope: FeedbackScope,
  job: JobEvidence,
  review: ReviewView,
  parties: Option.Option.Value<ReturnType<typeof partiesOf>>,
  authority: Partial<Pick<SidequestFeedbackEvidence, 'proposal' | 'grant'>>,
): SidequestFeedbackEntry => {
  const { clientAccount, payer, receiver, reviewEvent, reviewerLink, subjectLink } = parties
  const evidence: SidequestFeedbackEvidence = {
    job: job.view.job,
    operator: scope.operator,
    fundingTx: job.fundingTx,
    settlementTx: job.settlementTx,
    review: reviewEvent,
    reviewerLink,
    subjectLink,
    ...authority,
  }
  const registration = scope.registrations[0]
  return {
    ...(registration === undefined ? {} : registration),
    clientAddress: clientAccount,
    createdAt: isoSeconds(review.createdAt),
    value: starredValue(review.content.rating),
    valueDecimals: 0,
    ...feedbackTags,
    proofOfPayment: {
      fromAddress: addressOf(payer),
      toAddress: addressOf(receiver),
      chainId: chainIdOf(payer),
      txHash: job.fundingTx,
    },
    sidequest: evidence,
  }
}

/** The entry a counted review makes for the key, if it is about the key; `None` otherwise. */
const entryOf = (scope: FeedbackScope, job: JobEvidence, review: ReviewView): Option.Option<SidequestFeedbackEntry> =>
  Option.map(
    Option.all({ parties: partiesOf(job, review), authority: authorityOf(scope, job, review) }),
    ({ parties, authority }) => entryWith(scope, job, review, parties, authority),
  )

/** The item of an entry: where it is served and its document's hash. `None` if it cannot be canonicalized. */
const itemOf = (scope: FeedbackScope, entry: SidequestFeedbackEntry): Option.Option<SidequestFeedbackItem> =>
  Option.map(Result.getSuccess(entryDocument(entry)), (document) => ({
    feedbackURI: `${scope.origin}${entryPath(scope.subject, entry.sidequest.review.id)}`,
    feedbackHash: entryHash(document),
    entry,
  }))

/** The key's feedback file from its settled jobs' evidence: newest review first. */
export const feedbackFileOf = (scope: FeedbackScope, jobs: ReadonlyArray<JobEvidence>): SidequestFeedbackFile => {
  const items = jobs
    .flatMap((job) => job.view.reviews.flatMap((review) => Option.toArray(entryOf(scope, job, review))))
    .flatMap((entry) => Option.toArray(itemOf(scope, entry)))
    .toSorted(
      (left, right) =>
        right.entry.sidequest.review.created_at - left.entry.sidequest.review.created_at ||
        left.entry.sidequest.review.id.localeCompare(right.entry.sidequest.review.id),
    )
  const ratings = items.map((item) => item.entry.value / 20)
  return {
    subject: scope.subject,
    registrations: scope.registrations,
    count: items.length,
    averageRating: ratings.length === 0 ? null : ratings.reduce((sum, rating) => sum + rating, 0) / ratings.length,
    items,
  }
}
