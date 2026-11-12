import {
  AccountId,
  SessionView,
  Digest,
  EscrowStatus,
  FundingRequest,
  JobId,
  JobView,
  ListingId,
  Proposal,
  ProposalId,
  RoomId,
  Terms,
  TypedData,
  UsdcOnArcTestnet,
} from '@sidequest/protocol'
import { Schema } from 'effect'

// Records as the API returns them, for the page tests. Times are fixed instants; the views format them in the
// reader's time zone, so tests assert on amounts and words rather than on dates.

export const ada = AccountId.make('account_01JQ0000000000000000000ADA')
export const ben = AccountId.make('account_01JQ0000000000000000000BEN')
export const cleo = AccountId.make('account_01JQ0000000000000000000CEE')
export const job = JobId.make('job_01JQ00000000000000000000J1')
export const listing = ListingId.make('listing_01JQ00000000000000000000K1')
export const engagementRoom = RoomId.make('room_01JQ00000000000000000000J1_engagement')
export const benRoom = RoomId.make('room_01JQ00000000000000000000J1_negotiation_01JQ0000000000000000000BEN')
export const wallet = '0x1111111111111111111111111111111111111111'
export const workerWallet = '0x2222222222222222222222222222222222222222'
export const signature = `0x${'ab'.repeat(65)}`
export const transaction = `0x${'cd'.repeat(32)}`
export const paymentHash = `0x${'ef'.repeat(32)}`
const day = 86_400
const now = 1_800_000_000

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

const digest = (fill: string) => Digest.make(fill.repeat(64))

export const proposal = (bidder: AccountId, version: number, amount: string, fill: string): Proposal =>
  Schema.decodeSync(Proposal)({
    id: ProposalId.make(`proposal_01JQ000000000000000000${bidder.slice(-3)}${version}`),
    job,
    bidder,
    version,
    ...(version === 1 ? {} : { previous: version - 1 }),
    terms: termsFor(`A logo, version ${version}`, amount),
    termsDigest: digest(fill),
  })

export const request = {
  id: job,
  buyer: ada,
  title: 'A logo for my café',
  description: 'Warm colours.',
  expiresAt: now + 7 * day,
}

const benV1 = proposal(ben, 1, '250000000', 'a')
const benV2 = proposal(ben, 2, '300000000', 'b')
const cleoV1 = proposal(cleo, 1, '280000000', 'c')

/** Ada's job with Ben's two versions and Cleo's one, open. */
export const buyerOpen = Schema.decodeSync(JobView)({
  audience: 'buyer',
  view: {
    request,
    state: 'Open',
    proposals: [benV1, cleoV1, benV2],
    changesRequested: [{ bidder: ben, version: 1, termsDigest: benV1.termsDigest }],
    agreement: null,
    funding: null,
    delivery: null,
    review: null,
    dispute: null,
    outcome: null,
    settlement: [],
    reviews: [],
  },
})

/** Ben's side of it: his versions, a change asked for on the first. */
export const bidderPending = Schema.decodeSync(JobView)({
  audience: 'bidder',
  view: { job, bidder: ben, proposals: [benV1, benV2], changesRequested: [1], outcome: 'pending' },
})

export const publicOpen = Schema.decodeSync(JobView)({ audience: 'public', view: { request, state: 'Open' } })

export const escrow = (stage: EscrowStatus['stage'], extra: Partial<typeof EscrowStatus.Encoded> = {}): EscrowStatus =>
  Schema.decodeSync(EscrowStatus)({
    paymentHash,
    chainTime: now,
    stage,
    funding: null,
    delivery: null,
    rejection: null,
    settlement: null,
    problems: [],
    ...extra,
  })

export const typedData = Schema.decodeSync(TypedData)({
  domain: { name: 'SidequestOperator', version: '1', chainId: 5042002, verifyingContract: wallet },
  types: { Approval: [{ name: 'paymentInfoHash', type: 'bytes32' }] },
  primaryType: 'Approval',
  message: { paymentInfoHash: paymentHash },
})

/** What the server prepared for Ada to fund Ben's second version: 300 USDC, 5 % fee. */
export const fundingRequest = Schema.decodeSync(FundingRequest)({
  request: 'payment-1',
  state: 'begun',
  paymentHash,
  network: UsdcOnArcTestnet.network,
  asset: UsdcOnArcTestnet.id,
  amount: '300000000',
  payer: wallet,
  receiver: workerWallet,
  operator: '0x3333333333333333333333333333333333333333',
  escrow: '0xf96815976523E00e65Be8f34cA5e64b4f41EB19c',
  arbitrator: '0x4444444444444444444444444444444444444444',
  feeReceiver: '0x5555555555555555555555555555555555555555',
  feeBps: 500,
  deliveryDeadline: now + 7 * day,
  reviewWindowSeconds: 3 * day,
  disputeWindowSeconds: 2 * day,
  arbitrationWindowSeconds: 7 * day,
  preApprovalExpiry: now + day,
  authorizationExpiry: now + 20 * day,
  typedData: {
    domain: {
      name: 'USDC',
      version: '2',
      chainId: 5042002,
      verifyingContract: '0x3600000000000000000000000000000000000000',
    },
    types: { ReceiveWithAuthorization: [{ name: 'from', type: 'address' }] },
    primaryType: 'ReceiveWithAuthorization',
    message: { from: wallet },
  },
})

/** Ada, signed in with her wallet. */
export const adaSession = Schema.decodeSync(SessionView)({
  account: ada,
  wallet: `eip155:5042002:${wallet}`,
  expiresAt: 1_800_600_000,
})
