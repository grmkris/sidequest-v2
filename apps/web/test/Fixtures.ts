import { JobView, type ProposalView } from '@sidequest/fold'
import { AccountId, JobId, SessionView, Terms, UsdcOnArcTestnet } from '@sidequest/protocol'
import { Schema } from 'effect'

// Records as the API returns them, for the page tests. Times are fixed instants; the views format them in the
// reader's time zone, so tests assert on amounts and words rather than on dates.

export const ada = AccountId.make('account_01JQ0000000000000000000ADA')
export const job = JobId.make('job_01JQ00000000000000000000J1')
export const wallet = '0x1111111111111111111111111111111111111111'
export const signature = `0x${'ab'.repeat(65)}`
const day = 86_400
export const now = 1_800_000_000

/** Ada, signed in with her wallet (phase 1's session, which the agents and inbox pages still use). */
export const adaSession = Schema.decodeSync(SessionView)({
  account: ada,
  wallet: `eip155:5042002:${wallet}`,
  expiresAt: 1_800_600_000,
})

// Nostr: people are keys, a job is its request event's id.

export const buyerKey = 'a1'.repeat(32)
export const bidderKey = 'b2'.repeat(32)
export const otherKey = 'c3'.repeat(32)
export const requestId = 'd4'.repeat(32)
export const bidderAccount = 'eip155:5042002:0x2222222222222222222222222222222222222222'

export const termsFor = (title: string, amount: string): Terms =>
  Schema.decodeSync(Terms)({
    title,
    deliverables: ['An SVG logo', 'A PNG at 2048 px'],
    amount,
    asset: UsdcOnArcTestnet.id,
    network: UsdcOnArcTestnet.network,
    deliveryDeadline: now + 7 * day,
    reviewWindowSeconds: 3 * day,
    disputeWindowSeconds: 2 * day,
    arbitrationWindowSeconds: 7 * day,
    rail: 'escrow',
  })

type Labels = Partial<Pick<ProposalView, 'superseded' | 'withdrawn' | 'expired' | 'accepted' | 'funded' | 'otherBuyer'>>

/** A proposal as the fold shows it: by `author`, with its id filled from `fill`, and the labels given. */
export const proposalFrom = (
  author: string,
  fill: string,
  amount: string,
  labels: Labels = {},
  previous?: string,
): typeof ProposalView.Encoded => ({
  id: fill.repeat(64 / fill.length),
  author,
  createdAt: now + 60,
  content: {
    job: requestId,
    buyer: buyerKey,
    terms: Schema.encodeSync(Terms)(termsFor(`A logo for ${amount}`, amount)),
    termsDigest: `${fill}0f`.repeat(16),
    payTo: bidderAccount,
    validUntil: now + 7 * day,
    ...(previous === undefined ? {} : { previous }),
  },
  superseded: false,
  withdrawn: false,
  expired: false,
  accepted: false,
  funded: false,
  otherBuyer: false,
  ...labels,
})

/** A job as the index folds it: Ada's request for a logo, open until a week from `now`, and what `extra` adds. */
export const foldedJob = (extra: Partial<typeof JobView.Encoded> = {}): JobView =>
  Schema.decodeSync(JobView)({
    job: requestId,
    stage: 'open',
    buyer: buyerKey,
    worker: null,
    request: {
      id: requestId,
      author: buyerKey,
      createdAt: now,
      content: { title: 'A logo for my café', description: 'Warm colours.', expiresAt: now + 7 * day },
      expired: false,
      closedByBuyer: false,
    },
    proposals: [],
    accepts: [],
    funding: null,
    delivery: null,
    rejection: null,
    ending: null,
    deadlines: { deliveryOverdue: false, reviewWindowOpen: false, arbitrationOpen: false, reclaimable: false },
    deliveryNotes: [],
    statements: [],
    reviews: [],
    ...extra,
  })
