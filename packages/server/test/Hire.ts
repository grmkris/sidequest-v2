import { system } from '@sidequest/domain/Actor'
import { CurrentActor } from '@sidequest/domain/CurrentActor.context'
import { Job } from '@sidequest/domain/Job/Job.aggregate'
import { RecordDelivery } from '@sidequest/domain/Job/RecordDelivery.command'
import { RecordFunding } from '@sidequest/domain/Job/RecordFunding.command'
import { RecordRejection } from '@sidequest/domain/Job/RecordRejection.command'
import { RecordSettlement } from '@sidequest/domain/Job/RecordSettlement.command'
import {
  type Agreement,
  type BuyerJobView,
  Digest,
  JobId,
  JobView,
  type Proposal,
  ProposalId,
  Receipt,
  UsdcOnArcTestnet,
} from '@sidequest/protocol'
import { Effect, Option, Schema } from 'effect'
import {
  type Api,
  bodyOf,
  createdId,
  eventually,
  inSeconds,
  type Person,
  type Reply,
  request,
  terms,
} from './HttpWorld.ts'

// The hire's steps over HTTP, and the chain's reports the settlement saga will send, which tests send to the model
// directly as the system: no HTTP request can.

/** Post a request as `buyer`; its id. */
export const postJob = async (buyer: Person, title?: string) =>
  createdId(JobId, await buyer.post('/api/jobs', request(title)))

/** Propose on `job` as `bidder`, naming their head as `previous` after the first; the proposal's id. */
export const propose = async (bidder: Person, job: JobId, previous?: number, offer = terms()) =>
  createdId(
    ProposalId,
    await bidder.post(
      `/api/jobs/${job}/proposals`,
      previous === undefined ? { terms: offer } : { previous, terms: offer },
    ),
  )

/** A job as the reply shows it to its reader. */
export const jobViewOf = (reply: Reply) => bodyOf(JobView, reply)

const buyersView = (reply: Reply) =>
  Option.flatMap(Schema.decodeUnknownOption(JobView)(reply.body), (shown) =>
    shown.audience === 'buyer' ? Option.some(shown.view) : Option.none(),
  )

/** The buyer's view of `job`, once it shows what `done` waits for. */
export const buyerViewOf = async (buyer: Person, job: JobId, done: (view: BuyerJobView) => boolean = () => true) => {
  const reply = await eventually(
    () => buyer.get(`/api/jobs/${job}`),
    (answer) => Option.exists(buyersView(answer), done),
  )
  return Option.getOrThrowWith(buyersView(reply), () => new Error(`The buyer was not shown ${job} as its buyer`))
}

/** How the buyer names one exact proposal version. */
export const named = ({ bidder, version, termsDigest }: Proposal) => ({ bidder, version, termsDigest })

const bytes32 = (digit: string) => `0x${digit.repeat(64)}`

/** What the chain reader verified for `agreement`: an escrow operation on its amount. */
const receipt = (agreement: Agreement, operation: Receipt['operation']) =>
  Schema.decodeUnknownSync(Receipt)({
    job: agreement.job,
    rail: 'escrow',
    network: UsdcOnArcTestnet.network,
    operation,
    asset: UsdcOnArcTestnet.id,
    amount: agreement.terms.amount,
    payer: `${UsdcOnArcTestnet.network}:0x00000000000000000000000000000000000a11ce`,
    payee: `${UsdcOnArcTestnet.network}:0x0000000000000000000000000000000000000b0b`,
    paymentHash: bytes32('1'),
    transactionHash: bytes32(operation === 'authorize' ? '2' : '3'),
    status: 'success',
    confirmations: 3,
  })

const asSettlement = Effect.provideService(CurrentActor, system('settlement'))

/** The chain reports the buyer funded the escrow for `agreement`. */
export const recordFunding = (api: Api, agreement: Agreement) =>
  api.run(
    Effect.gen(function* () {
      return yield* (yield* Job).send(agreement.job, new RecordFunding({ receipt: receipt(agreement, 'authorize') }))
    }).pipe(asSettlement),
  )

/** An artifact's SHA-256, as the worker hands it over. */
export const artifactHash = Digest.make('9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08')

/** The chain reports the delivery hash was posted a minute ago. */
export const recordDelivery = (api: Api, job: JobId) =>
  api.run(
    Effect.gen(function* () {
      return yield* (yield* Job).send(job, new RecordDelivery({ artifactHash, deliveredAt: inSeconds(-60) }))
    }).pipe(asSettlement),
  )

/** The chain reports the buyer rejected the delivery a minute ago. */
export const recordRejection = (api: Api, job: JobId) =>
  api.run(
    Effect.gen(function* () {
      return yield* (yield* Job).send(job, new RecordRejection({ rejectedAt: inSeconds(-60) }))
    }).pipe(asSettlement),
  )

/** The chain reports the escrow paid the worker. */
export const recordSettlement = (api: Api, agreement: Agreement) =>
  api.run(
    Effect.gen(function* () {
      return yield* (yield* Job).send(
        agreement.job,
        new RecordSettlement({ receipts: [receipt(agreement, 'capture')] }),
      )
    }).pipe(asSettlement),
  )
