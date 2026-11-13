import { JobView } from '@sidequest/fold'
import {
  Bytes32,
  EscrowFunding,
  EscrowPaymentStatus,
  EscrowRefusalReason,
  EscrowRefused,
  NetworkRef,
  NotIndexed,
  RateLimited,
  TypedData,
  WalletAddress,
  WalletSignature,
} from '@sidequest/protocol'
import { Option, Schema } from 'effect'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { FormStatus } from '../../../Forms.ts'
import { Language } from '../../../Language.ts'
import { Problem, problemOf } from '../../../Problem.ts'
import { PublishFailure } from '../../../Publishing.ts'
import { Connection } from '../../../Wallet.ts'

// The hire's money on the job page, for its buyer and its worker (ADR-0003: only wallet signatures bind). Each step is
// one signature in the person's wallet over typed data the API prepared, which the API relays through the
// escrow endpoints: fund (the buyer's ERC-3009 authorization), deliver (the worker's delivery hash, after their signed
// delivery note), approve or reject (the buyer, a rejection after their signed reason). Before anything is signed the
// page checks that the connected wallet is the one the step needs; after the relay it reads the job until the fold
// shows the step, and offers to read again rather than wait for ever.

// MODEL

/** A money step: whose signature it is and what it moves. */
export const Step = Schema.Literals(['fund', 'deliver', 'approve', 'reject'])
export type Step = typeof Step.Type

/** What a step carries besides its signature. */
export const Work = defineTaggedUnion({
  Fund: { proposal: Schema.String },
  Deliver: {
    buyer: Schema.String,
    network: NetworkRef,
    maybeUrl: Schema.Option(Schema.String),
    maybeNote: Schema.Option(Schema.String),
  },
  Approve: {},
  Reject: { reason: Schema.String },
})
export type Work = typeof Work.Type

export const stepOf = (work: Work): Step =>
  Work.match(work, {
    Fund: (): Step => 'fund',
    Deliver: (): Step => 'deliver',
    Approve: (): Step => 'approve',
    Reject: (): Step => 'reject',
  })

/** Why a step stopped: the API's typed refusal, its rate limit, a job it does not index, an event that was not
 * published, or a problem with the wallet or the network. */
export const MoneyFailure = defineTaggedUnion({
  Refused: { reason: EscrowRefusalReason, maybeDetail: Schema.Option(Schema.String) },
  RateLimited: { retryAfterSeconds: Schema.Int },
  NotIndexed: {},
  Unpublished: { failure: PublishFailure },
  Failed: { problem: Problem },
})
export type MoneyFailure = typeof MoneyFailure.Type

/** A step about to start, and the wallet that must sign it: the one linked to the person's key that the escrow names
 * (or, to fund, the one the payment will name). */
export const Attempt = Schema.Struct({ work: Work, signer: WalletAddress })
export type Attempt = typeof Attempt.Type

/** The wallet answered as the signer; a delivery's hash once its note is published. */
export const Connected = Schema.Struct({
  ...Attempt.fields,
  connection: Connection,
  maybeDeliveryHash: Schema.Option(Bytes32),
})
export type Connected = typeof Connected.Type

/** What the wallet will sign, as the API prepared it, and to fund, the payment it binds. */
export const Prepared = Schema.Struct({
  ...Connected.fields,
  typedData: TypedData,
  maybeFunding: Schema.Option(EscrowFunding),
})
export type Prepared = typeof Prepared.Type

/** Where a money step is, one at a time. */
export const Flow = defineTaggedUnion({
  Idle: {},
  EditingDelivery: { attempt: Attempt, url: Schema.String, note: Schema.String, status: FormStatus },
  ConfirmingApproval: { attempt: Attempt },
  EditingRejection: { attempt: Attempt, reason: Schema.String, status: FormStatus },
  Connecting: { attempt: Attempt },
  WrongWallet: { attempt: Attempt, connected: WalletAddress },
  Publishing: { connected: Connected },
  Preparing: { connected: Connected },
  Ready: { prepared: Prepared },
  Switching: { prepared: Prepared },
  Signing: { prepared: Prepared },
  Submitting: { step: Step },
  Following: { step: Step, transactionHash: Bytes32, attempt: Schema.Int },
  GaveUp: { step: Step, transactionHash: Bytes32 },
  Done: { step: Step, transactionHash: Bytes32 },
  Failed: { step: Step, failure: MoneyFailure },
})
export type Flow = typeof Flow.Type

export const Model = Schema.Struct({
  language: Language,
  job: Schema.String,
  flow: Flow,
  /** The escrow and the relayed calls, once the job is funded: the transactions the page links to. */
  maybePayment: Schema.Option(EscrowPaymentStatus),
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  SucceededReadPayment: { status: EscrowPaymentStatus },
  FailedReadPayment: { problem: Problem },
  ClickedFund: { proposal: Schema.String, payer: WalletAddress },
  ClickedDeliver: { signer: WalletAddress, buyer: Schema.String, network: NetworkRef },
  UpdatedDeliveryUrl: { value: Schema.String },
  UpdatedDeliveryNote: { value: Schema.String },
  SubmittedDelivery: {},
  ClickedApprove: { signer: WalletAddress },
  ClickedConfirmApproval: {},
  ClickedReject: { signer: WalletAddress },
  UpdatedReason: { value: Schema.String },
  SubmittedRejection: {},
  ClickedCancel: {},
  ClickedTryAgain: {},
  SucceededReadWalletAccount: { connection: Connection },
  FailedReadWalletAccount: { problem: Problem },
  SucceededPublishEvent: { maybeDeliveryHash: Schema.Option(Bytes32) },
  FailedPublishEvent: { failure: PublishFailure },
  SucceededPrepare: { typedData: TypedData, maybeFunding: Schema.Option(EscrowFunding) },
  FailedPrepare: { failure: MoneyFailure },
  ClickedSwitchNetwork: {},
  SucceededSwitchNetwork: { chainId: Schema.Int },
  FailedSwitchNetwork: { problem: Problem },
  ClickedSign: {},
  SucceededSign: { signature: WalletSignature },
  FailedSign: { problem: Problem },
  SucceededSubmit: { transactionHash: Bytes32 },
  FailedSubmit: { failure: MoneyFailure },
  CompletedWaitBeforeCheck: {},
  SucceededReadJob: { view: JobView },
  FailedReadJob: { problem: Problem },
  ClickedCheckAgain: {},
  ClickedReadAgain: {},
})
export type Message = typeof Message.Type

/** The page read the job while following a step: the job page shows what it read. */
export const OutMessage = defineMessageUnion({ ReadJob: { view: JobView } })
export type OutMessage = typeof OutMessage.Type

// DERIVED

/** The API's refusal of a money call, or any other error, as a {@link MoneyFailure}. */
export const moneyFailureOf = (error: unknown): MoneyFailure => {
  if (error instanceof EscrowRefused) {
    return MoneyFailure.Refused({ reason: error.reason, maybeDetail: Option.fromNullishOr(error.detail) })
  }
  if (error instanceof RateLimited) {
    return MoneyFailure.RateLimited({ retryAfterSeconds: error.retryAfterSeconds })
  }
  if (error instanceof NotIndexed) {
    return MoneyFailure.NotIndexed()
  }
  return MoneyFailure.Failed({ problem: problemOf(error) })
}

/** Whether the fold shows the step a signature was for. */
export const reached = (step: Step, view: JobView): boolean => {
  const steps: Readonly<Record<Step, boolean>> = {
    fund: view.funding !== null,
    deliver: view.delivery !== null || view.ending !== null,
    approve: view.ending !== null,
    reject: view.rejection !== null || view.ending !== null,
  }
  return steps[step]
}

/** The same account, as wallets write addresses in either case. */
export const sameAddress = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase()

/** A CAIP-10 account's address (`eip155:5042002:0x…`), when it is an EVM one. */
export const addressOf = (account: string): Option.Option<typeof WalletAddress.Type> =>
  Schema.decodeUnknownOption(WalletAddress)(account.split(':')[2])

/** No step is in flight: a new one may start. */
export const settledFlow = (flow: Flow): boolean =>
  Flow.guards.Idle(flow) || Flow.guards.Failed(flow) || Flow.guards.Done(flow)
