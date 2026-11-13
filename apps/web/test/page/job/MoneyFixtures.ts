import type { JobView } from '@sidequest/fold'
import { IndexFunding, IndexPaymentStatus, TypedData, UsdcOnArcTestnet } from '@sidequest/protocol'
import { Schema } from 'effect'
import { bidderKey, foldedJob, now, proposalFrom, requestId } from '../../Fixtures.ts'

// The money of a job as the API and the fold answer it, for the money panel's tests: the buyer's and the worker's
// wallets on Arc testnet, a quote for the bidder's proposal, and the fold's job at each stage of its escrow.

const day = 86_400
export const arcChain = 5042002
export const buyerWallet = '0x1111111111111111111111111111111111111111'
export const workerWallet = '0x2222222222222222222222222222222222222222'
export const otherWallet = '0x9999999999999999999999999999999999999999'
export const buyerAccount = `eip155:${arcChain}:${buyerWallet}`
export const escrow = '0xbdea0d1bcc5966192b070fdf62ab4ef5b4420cff'
export const paymentHash = `0x${'5a'.repeat(32)}`
export const transactionHash = `0x${'7e'.repeat(32)}`
export const deliveryHash = `0x${'de'.repeat(32)}`
export const signature = `0x${'ab'.repeat(65)}`

export const proposal = proposalFrom(bidderKey, 'e1', '250000000', { accepted: true })

/** What a wallet signs, as the API prepares it: on Arc testnet unless `chainId` says otherwise. */
export const typedDataOn = (primaryType: string, chainId = arcChain): TypedData =>
  Schema.decodeSync(TypedData)({
    domain: { name: 'USDC', version: '2', chainId, verifyingContract: '0x3600000000000000000000000000000000000000' },
    types: { [primaryType]: [{ name: 'value', type: 'uint256' }] },
    primaryType,
    message: { value: '250000000' },
  })

/** The quote for the bidder's proposal, paid from the buyer's wallet to the worker's, with Sidequest's 5 % fee. */
export const quote = Schema.decodeSync(IndexFunding)({
  job: requestId,
  proposal: proposal.id,
  paymentHash,
  network: UsdcOnArcTestnet.network,
  asset: UsdcOnArcTestnet.id,
  amount: '250000000',
  paymentInfo: {
    operator: '0x979ef80b97702ebcfcf6b0d9f9fc015c50c15a99',
    payer: buyerWallet,
    receiver: workerWallet,
    token: '0x3600000000000000000000000000000000000000',
    maxAmount: '250000000',
    preApprovalExpiry: now + 7 * day,
    authorizationExpiry: now + 20 * day,
    refundExpiry: now + 20 * day,
    minFeeBps: 500,
    maxFeeBps: 500,
    feeReceiver: '0x7777777777777777777777777777777777777777',
    salt: '12345',
  },
  jobParams: {
    jobId: `0x${requestId}`,
    termsDigest: `0x${proposal.content.termsDigest}`,
    deliveryDeadline: now + 7 * day,
    reviewWindow: 3 * day,
    disputeWindow: 2 * day,
    arbitrationWindow: 7 * day,
    arbitrator: '0x8888888888888888888888888888888888888888',
  },
  escrow,
  typedData: typedDataOn('ReceiveWithAuthorization'),
})

const at = (block: number) => ({ at: { block, logIndex: 0 }, paymentHash })

const funded = {
  _tag: 'Funded',
  ...at(10),
  job: requestId,
  termsDigest: proposal.content.termsDigest,
  payer: buyerAccount,
  receiver: `eip155:${arcChain}:${workerWallet}`,
  asset: UsdcOnArcTestnet.id,
  amount: '250000000',
  deliveryDeadline: now + 7 * day,
  reviewWindowSeconds: 3 * day,
  disputeWindowSeconds: 2 * day,
  arbitrationWindowSeconds: 7 * day,
  arbitrator: `eip155:${arcChain}:0x8888888888888888888888888888888888888888`,
  authorizationExpiry: now + 20 * day,
} as const

const delivered = {
  _tag: 'Delivered',
  ...at(11),
  deliveryHash,
  deliveredAt: now + day,
  reviewEndsAt: now + 4 * day,
} as const
const rejected = { _tag: 'Rejected', ...at(12), rejectedAt: now + 2 * day, arbitrationEndsAt: now + 11 * day } as const
const deadlines = { deliveryOverdue: false, reviewWindowOpen: false, arbitrationOpen: false, reclaimable: false }

const fundingView = {
  fact: funded,
  proposal: proposal.id,
  terms: 'known',
  termsAmbiguous: false,
  termsMatchChain: true,
  payerLinked: true,
  receiverLinked: true,
  otherPayments: [],
} as const

/** The fold's job once the chain funded the bidder's proposal, and as far as `stage` goes. */
export const moneyJob = (
  stage: 'accepted' | 'funded' | 'delivered' | 'rejected' | 'released',
  extra: Partial<typeof JobView.Encoded> = {},
): JobView => {
  const chain = (
    {
      accepted: {},
      funded: { funding: fundingView },
      delivered: { funding: fundingView, delivery: delivered, deadlines: { ...deadlines, reviewWindowOpen: true } },
      rejected: {
        funding: fundingView,
        delivery: delivered,
        rejection: rejected,
        deadlines: { ...deadlines, arbitrationOpen: true },
      },
      released: {
        funding: fundingView,
        delivery: delivered,
        ending: {
          _tag: 'Settled',
          ...at(13),
          outcome: 'Approved',
          workerShareBps: 10_000,
          capturedAmount: '250000000',
          feeAmount: '12500000',
          refundedAmount: '0',
          settledAt: now + 2 * day,
        },
      },
    } as const
  )[stage]
  return foldedJob({
    stage,
    worker: stage === 'accepted' ? null : bidderKey,
    proposals: [{ ...proposal, funded: stage !== 'accepted' }],
    ...chain,
    ...extra,
  })
}

/** The payment as `GET /api/index/jobs/:id/payment` answers it: the escrow, and the calls relayed so far. */
export const payment = (intents: ReadonlyArray<string>): IndexPaymentStatus =>
  Schema.decodeSync(IndexPaymentStatus)({
    escrow,
    paymentHash,
    chainTime: now + 3 * day,
    stage: 'Settled',
    outcome: 'Approved',
    relayed: intents.map((intent) => ({
      intent: `${intent}:${paymentHash}`,
      state: 'mined',
      transactionHash,
      reason: null,
    })),
  })
