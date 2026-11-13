import {
  agentGrant,
  envelopeTag,
  jobIdWord,
  jobProposal,
  jobReview,
  type JobReviewContent,
  type KindSpec,
  type ParsedEvent,
  parseSidequestEvent,
  walletLink,
} from '@sidequest/nostr/vocabulary'
import { type SidequestFeedbackEntry, SidequestFeedbackFile, type SidequestFeedbackItem } from '@sidequest/protocol'
import { sidequestOperatorAbi } from '@sidequest/settlement/abi/SidequestOperator'
import type { EventId } from '@sidequest/nostr'
import { rpcCall } from '@sidequest/settlement/ChainRpc'
import { Effect, Option, Result, Schema } from 'effect'
import { type Address, decodeEventLog, type Hex, isAddress, isAddressEqual, isHex, type PublicClient } from 'viem'
import { verifyWalletLink } from '../Index/Derived.ts'
import { entryDocument, entryHash, feedbackTags, isoSeconds, starredValue } from './Feedback.ts'

// A third party's check of a Sidequest feedback file (ADR-0007, decision 6), from the file and a JSON-RPC endpoint of
// the job chain alone: nothing here reads Sidequest's index. For each entry: its document hashes to its
// `feedbackHash`; its review is a valid signed review of its job, whose rating and time are the entry's; the two wallet
// links are valid, their wallets' EIP-712 signatures recovering to the escrow's two sides; the funding transaction
// logged `JobFunded` from the named operator for that job, between those wallets, and the settlement transaction
// `JobSettled` for the same payment; and the review is about the file's key, or about the operator whose agent (the
// file's key) signed the funded proposal under their grant. A revocation of that grant is not checked: the fold keeps a
// funded proposal its operator's whenever a revocation came, and so does this.

/** Why an entry does not check out: the first check it fails. */
export const EntryFailure = Schema.Literals([
  'hash',
  'review',
  'links',
  'funding',
  'settlement',
  'subject',
  'chainUnavailable',
])
export type EntryFailure = typeof EntryFailure.Type

/** One entry's verdict, by its review's id. */
export interface EntryVerdict {
  readonly review: string
  readonly failure: Option.Option<EntryFailure>
}

/** The verdicts of a file's entries, in its order. */
export interface FileVerdict {
  readonly subject: string
  readonly entries: ReadonlyArray<EntryVerdict>
}

const parsed = <C>(spec: KindSpec<C>, event: unknown) =>
  Effect.option(parseSidequestEvent(spec, event)).pipe(Effect.map(Option.getOrUndefined))

const addressOfAccount = (account: string) => account.slice(account.lastIndexOf(':') + 1)

/** Whether text is an EVM address, and that one, in any letter case. */
const sameAddress = (text: string, address: Address) =>
  isAddress(text, { strict: false }) && isAddressEqual(text, address)

/** The operator log of `name` in a mined transaction, decoded; `None` if there is none from `operator`. */
const operatorLog = (rpc: PublicClient, hash: string, operator: Address, name: 'JobFunded' | 'JobSettled') =>
  Effect.gen(function* () {
    if (!isHex(hash)) return Option.none()
    const receipt = yield* rpcCall('eth_getTransactionReceipt', () => rpc.getTransactionReceipt({ hash }))
    if (receipt.status !== 'success') return Option.none()
    const decoded = yield* Effect.forEach(
      receipt.logs.filter((log) => isAddressEqual(log.address, operator)),
      (log) =>
        Effect.option(
          Effect.try(() => decodeEventLog({ abi: sidequestOperatorAbi, data: log.data, topics: log.topics })),
        ),
    )
    return Option.fromUndefinedOr(decoded.flatMap(Option.toArray).find((event) => event.eventName === name))
  })

type Check = Effect.Effect<Option.Option<EntryFailure>>
const failing = (failure: EntryFailure) => Option.some(failure)

/** What `JobFunded` logged, as the checks read it. */
interface Funded {
  readonly paymentInfoHash: Hex
  readonly jobId: Hex
  readonly termsDigest: Hex
  readonly payer: Address
  readonly receiver: Address
}

/** The entry's document hashes to its `feedbackHash`. */
const hashHolds = (item: SidequestFeedbackItem) =>
  Result.match(entryDocument(item.entry), {
    onFailure: () => false,
    onSuccess: (document) => entryHash(document) === item.feedbackHash,
  })

/** The review is of the entry's job, and the entry's rating, time and tags are the review's. */
const reviewHolds = (entry: SidequestFeedbackEntry, review: ParsedEvent<JobReviewContent>) =>
  review.content.job === entry.sidequest.job &&
  entry.value === starredValue(review.content.rating) &&
  entry.createdAt === isoSeconds(review.event.created_at) &&
  entry.tag1 === feedbackTags.tag1 &&
  entry.tag2 === feedbackTags.tag2

/** The funding is the review's job's, between the escrow's two sides, the client one of them, on this chain. */
const paymentHolds = (entry: SidequestFeedbackEntry, funded: Funded, job: EventId, chainId: number) => {
  const client = addressOfAccount(entry.clientAddress)
  const proof = entry.proofOfPayment
  const sideOk = sameAddress(client, funded.payer) || sameAddress(client, funded.receiver)
  const proofOk =
    sameAddress(proof.fromAddress, funded.payer) &&
    sameAddress(proof.toAddress, funded.receiver) &&
    proof.txHash === entry.sidequest.fundingTx &&
    proof.chainId === String(chainId)
  return funded.jobId === jobIdWord(job) && sideOk && proofOk
}

/** The agent's authority: its funded proposal, under the reviewed operator's grant with the `propose` scope. */
const agentProves = (item: SidequestFeedbackItem, subject: string, operator: string, funded: Funded) =>
  Effect.gen(function* () {
    const proposal = yield* parsed(jobProposal, item.entry.sidequest.proposal)
    const grant = yield* parsed(agentGrant, item.entry.sidequest.grant)
    if (proposal === undefined || grant === undefined) return false
    const named = proposal.event.tags.find((tag) => tag[0] === envelopeTag.grant)?.[1]
    const at = proposal.event.created_at
    return (
      proposal.event.pubkey === subject &&
      proposal.content.job === item.entry.sidequest.job &&
      `0x${proposal.content.termsDigest}` === funded.termsDigest &&
      sameAddress(addressOfAccount(proposal.content.payTo), funded.receiver) &&
      grant.event.pubkey === operator &&
      grant.content.agent === subject &&
      grant.content.scopes.includes('propose') &&
      named === grant.event.id &&
      at >= grant.content.notBefore &&
      at < grant.content.expiresAt
    )
  })

const linkOf = (event: unknown, address: string) =>
  Effect.map(parsed(walletLink, event), (link) =>
    link !== undefined &&
    verifyWalletLink(link.event, link.content) === 'verified' &&
    addressOfAccount(link.content.address) === address.toLowerCase()
      ? link
      : undefined,
  )

/** A failed check, carried on the error channel so the checks read in order. */
class Failed extends Schema.TaggedError<Failed>()('Failed', { failure: EntryFailure }) {}

/** Passes `value` on when it is there and `holds`; otherwise fails `failure`. */
const required = <A>(value: A | undefined, failure: EntryFailure, holds: (found: A) => boolean = () => true) =>
  value !== undefined && holds(value) ? Effect.succeed(value) : Effect.fail(new Failed({ failure }))

/** The decoded log of `name` the operator emitted in a transaction, if it emitted one. */
const loggedBy = (rpc: PublicClient, hash: string, operator: Address, name: 'JobFunded' | 'JobSettled') =>
  Effect.map(operatorLog(rpc, hash, operator, name), (log) =>
    Option.getOrUndefined(Option.filter(log, (found) => found.eventName === name)),
  )

const checks = (rpc: PublicClient, subject: string, item: SidequestFeedbackItem) =>
  Effect.gen(function* () {
    const { entry } = item
    const evidence = entry.sidequest
    yield* required(item, 'hash', hashHolds)
    const review = yield* required(yield* parsed(jobReview, evidence.review), 'review', (found) =>
      reviewHolds(entry, found),
    )
    const named = addressOfAccount(evidence.operator)
    const operator = yield* required(isAddress(named, { strict: false }) ? named : undefined, 'funding')
    const chainId = yield* rpcCall('eth_chainId', () => rpc.getChainId())
    const funding = yield* required(yield* loggedBy(rpc, evidence.fundingTx, operator, 'JobFunded'), 'funding')
    const funded = yield* required(funding.eventName === 'JobFunded' ? funding.args : undefined, 'funding', (args) =>
      paymentHolds(entry, args, review.content.job, chainId),
    )
    const reviewerIsPayer = sameAddress(addressOfAccount(entry.clientAddress), funded.payer)
    const [reviewerSide, subjectSide] = reviewerIsPayer
      ? [funded.payer, funded.receiver]
      : [funded.receiver, funded.payer]
    yield* required(
      yield* linkOf(evidence.reviewerLink, reviewerSide),
      'links',
      (link) => link.event.pubkey === review.event.pubkey,
    )
    yield* required(
      yield* linkOf(evidence.subjectLink, subjectSide),
      'links',
      (link) => link.event.pubkey === review.content.subject,
    )
    const settled = yield* loggedBy(rpc, evidence.settlementTx, operator, 'JobSettled')
    yield* required(
      settled,
      'settlement',
      (log) => log.eventName === 'JobSettled' && log.args.paymentInfoHash === funded.paymentInfoHash,
    )
    const aboutSubject = review.content.subject === subject
    const byAgent =
      !aboutSubject && reviewerIsPayer && (yield* agentProves(item, subject, review.content.subject, funded))
    yield* required(aboutSubject || byAgent, 'subject', (holds) => holds)
  })

const verifyItem = (rpc: PublicClient, subject: string, item: SidequestFeedbackItem): Check =>
  checks(rpc, subject, item).pipe(
    Effect.as(Option.none<EntryFailure>()),
    Effect.catchTags({
      Failed: ({ failure }) => Effect.succeed(Option.some(failure)),
      ChainUnavailable: () => Effect.succeed(failing('chainUnavailable')),
    }),
  )

/** Why a file could not be read at all: it is not a Sidequest feedback file. */
export class NotAFeedbackFile extends Schema.TaggedError<NotAFeedbackFile>()('NotAFeedbackFile', {}) {}

/** Checks every entry of a feedback file against the chain `rpc` reads; each verdict says which check failed, if any. */
export const verifyFeedbackFile = (input: unknown, rpc: PublicClient): Effect.Effect<FileVerdict, NotAFeedbackFile> =>
  Effect.gen(function* () {
    const file = yield* Schema.decodeUnknownEffect(SidequestFeedbackFile)(input).pipe(
      Effect.mapError(() => new NotAFeedbackFile()),
    )
    const entries = yield* Effect.forEach(file.items, (item) =>
      Effect.map(verifyItem(rpc, file.subject, item), (failure) => ({
        review: item.entry.sidequest.review.id,
        failure,
      })),
    )
    return { subject: file.subject, entries }
  })
