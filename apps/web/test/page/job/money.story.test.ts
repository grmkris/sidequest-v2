import { EscrowRefusalReason, EscrowRefused, NetworkRef, NotIndexed, RateLimited } from '@sidequest/protocol'
import { Array, Option } from 'effect'
import { Command, expectNoOutMessage, expectOutMessage, given, message, model, story } from 'foldkit/story'
import { describe, expect, test } from 'vitest'
import { FormStatus } from '../../../src/Forms.ts'
import {
  Flow,
  Message,
  type Model,
  MoneyFailure,
  moneyFailureOf,
  OutMessage,
  Work,
} from '../../../src/page/job/money/message.ts'
import {
  ReadWalletAccount,
  init,
  mostChecks,
  PrepareSignature,
  PublishDeliveryNote,
  PublishRejectionReason,
  Quote,
  ReadMoneyJob,
  ReadPayment,
  SignTypedData,
  Submit,
  SwitchNetwork,
  update,
  WaitBeforeCheck,
} from '../../../src/page/job/money/update.ts'
import { Problem } from '../../../src/Problem.ts'
import { PublishFailure } from '../../../src/Publishing.ts'
import { buyerKey, requestId } from '../../Fixtures.ts'
import {
  arcChain,
  buyerWallet,
  deliveryHash,
  moneyJob,
  otherWallet,
  payment,
  proposal,
  quote,
  signature,
  transactionHash,
  typedDataOn,
  workerWallet,
} from './MoneyFixtures.ts'

const fresh: Model = init('en', requestId)
const arc = NetworkRef.make(`eip155:${arcChain}`)
const connectedAs = (address: string, chainId = arcChain) =>
  Command.resolve(ReadWalletAccount, Message.SucceededReadWalletAccount({ connection: { address, chainId } }))

/** The buyer asks to fund the proposal and their wallet answers as `address` on `chainId`; the API quotes. */
const quoted = (address = buyerWallet, chainId = arcChain) => [
  message(Message.ClickedFund({ proposal: proposal.id, payer: buyerWallet })),
  Command.expectExact(ReadWalletAccount()),
  connectedAs(address, chainId),
  Command.expectExact(Quote({ job: requestId, proposal: proposal.id, payer: buyerWallet })),
  Command.resolve(Quote, Message.SucceededPrepare({ typedData: quote.typedData, maybeFunding: Option.some(quote) })),
]

/** The step before each one, as the fold still shows it until the chain's logs are indexed. */
const before = { funded: 'accepted', delivered: 'funded', released: 'delivered', rejected: 'delivered' } as const

/** The relay took the signature; the page reads the job until the fold shows `stage`, after `misses` reads that still
 * show the stage before. */
const followedTo = (stage: keyof typeof before, misses = 1) => [
  Command.resolve(Submit, Message.SucceededSubmit({ transactionHash })),
  ...Array.makeBy(misses, (attempt) => [
    Command.expectExact(WaitBeforeCheck({ attempt })),
    Command.resolve(WaitBeforeCheck, Message.CompletedWaitBeforeCheck()),
    Command.resolve(ReadMoneyJob, Message.SucceededReadJob({ view: moneyJob(before[stage]) })),
  ]).flat(),
  Command.resolve(WaitBeforeCheck, Message.CompletedWaitBeforeCheck()),
  Command.resolve(ReadMoneyJob, Message.SucceededReadJob({ view: moneyJob(stage) })),
  expectOutMessage(OutMessage.ReadJob({ view: moneyJob(stage) })),
  Command.expectExact(ReadPayment({ job: requestId })),
  Command.resolve(ReadPayment, Message.SucceededReadPayment({ status: payment(['fund']) })),
]

describe('funding', () => {
  test('the buyer reads the slip, their linked wallet signs the authorization, and the page follows until funded', () => {
    story(
      update,
      given(fresh),
      ...quoted(),
      model((money) =>
        expect(money.flow).toMatchObject({ _tag: 'Ready', prepared: { maybeFunding: Option.some(quote) } }),
      ),
      Command.expectNone(),
      message(Message.ClickedSign()),
      Command.expectExact(SignTypedData({ signer: buyerWallet, typedData: quote.typedData })),
      Command.resolve(SignTypedData, Message.SucceededSign({ signature })),
      Command.expectExact(
        Submit({
          job: requestId,
          work: Work.Fund({ proposal: proposal.id }),
          signer: buyerWallet,
          signature,
          maybeDeliveryHash: Option.none(),
        }),
      ),
      ...followedTo('funded', 2),
      model((money) => {
        expect(money.flow).toEqual(Flow.Done({ step: 'fund', transactionHash }))
        expect(Option.map(money.maybePayment, ({ escrow }) => escrow)).toEqual(Option.some(payment([]).escrow))
      }),
    )
  })

  test('every refusal of the quote stops the step with its reason, and so does one of the relay', () => {
    for (const reason of EscrowRefusalReason.literals) {
      const refused = MoneyFailure.Refused({ reason, maybeDetail: Option.none() })
      story(
        update,
        given(fresh),
        message(Message.ClickedFund({ proposal: proposal.id, payer: buyerWallet })),
        connectedAs(buyerWallet),
        Command.resolve(Quote, Message.FailedPrepare({ failure: refused })),
        model((money) => expect(money.flow).toEqual(Flow.Failed({ step: 'fund', failure: refused }))),
        Command.expectNone(),
      )
    }
    const chain = MoneyFailure.Refused({ reason: 'ChainRefused', maybeDetail: Option.some('AmountTooLow') })
    story(
      update,
      given(fresh),
      ...quoted(),
      message(Message.ClickedSign()),
      Command.resolve(SignTypedData, Message.SucceededSign({ signature })),
      Command.resolve(Submit, Message.FailedSubmit({ failure: chain })),
      model((money) => expect(money.flow).toEqual(Flow.Failed({ step: 'fund', failure: chain }))),
    )
  })

  test('reads every typed error of the API as its failure', () => {
    expect(moneyFailureOf(new EscrowRefused({ reason: 'PayerNotLinked' }))).toEqual(
      MoneyFailure.Refused({ reason: 'PayerNotLinked', maybeDetail: Option.none() }),
    )
    expect(moneyFailureOf(new EscrowRefused({ reason: 'ChainRefused', detail: 'x' }))).toEqual(
      MoneyFailure.Refused({ reason: 'ChainRefused', maybeDetail: Option.some('x') }),
    )
    expect(moneyFailureOf(new RateLimited({ retryAfterSeconds: 12 }))).toEqual(
      MoneyFailure.RateLimited({ retryAfterSeconds: 12 }),
    )
    expect(moneyFailureOf(new NotIndexed())).toEqual(MoneyFailure.NotIndexed())
    expect(moneyFailureOf(new Error('offline'))).toEqual(MoneyFailure.Failed({ problem: Problem.Unreachable() }))
  })

  test('a wallet that declines leaves nothing signed and the step stopped', () => {
    story(
      update,
      given(fresh),
      ...quoted(),
      message(Message.ClickedSign()),
      Command.resolve(SignTypedData, Message.FailedSign({ problem: Problem.WalletRejected() })),
      model((money) =>
        expect(money.flow).toEqual(
          Flow.Failed({ step: 'fund', failure: MoneyFailure.Failed({ problem: Problem.WalletRejected() }) }),
        ),
      ),
      Command.expectNone(),
    )
  })

  test('another account in the wallet is named before anything is asked of it, and the person can try again', () => {
    story(
      update,
      given(fresh),
      message(Message.ClickedFund({ proposal: proposal.id, payer: buyerWallet })),
      connectedAs(otherWallet),
      model((money) =>
        expect(money.flow).toEqual(
          Flow.WrongWallet({
            attempt: { work: Work.Fund({ proposal: proposal.id }), signer: buyerWallet },
            connected: otherWallet,
          }),
        ),
      ),
      Command.expectNone(),
      message(Message.ClickedTryAgain()),
      Command.expectExact(ReadWalletAccount()),
      connectedAs(buyerWallet.toUpperCase().replace('0X', '0x')),
      Command.expectExact(Quote({ job: requestId, proposal: proposal.id, payer: buyerWallet })),
      Command.resolve(Quote, Message.FailedPrepare({ failure: MoneyFailure.NotIndexed() })),
    )
  })

  test('a wallet on another chain is asked to switch, and the slip signs only once it is on Arc testnet', () => {
    story(
      update,
      given(fresh),
      ...quoted(buyerWallet, 1),
      model((money) => expect(Flow.guards.Ready(money.flow)).toBe(true)),
      message(Message.ClickedSign()),
      Command.expectNone(),
      message(Message.ClickedSwitchNetwork()),
      Command.expectExact(SwitchNetwork()),
      Command.resolve(SwitchNetwork, Message.SucceededSwitchNetwork({ chainId: arcChain })),
      model((money) => expect(Flow.guards.Ready(money.flow)).toBe(true)),
      message(Message.ClickedSign()),
      Command.expectExact(SignTypedData({ signer: buyerWallet, typedData: quote.typedData })),
      Command.resolve(SignTypedData, Message.FailedSign({ problem: Problem.WalletRejected() })),
    )
  })

  test('a status that never arrives ends in an offer to check again, not a wait for ever', () => {
    story(
      update,
      given(fresh),
      ...quoted(),
      message(Message.ClickedSign()),
      Command.resolve(SignTypedData, Message.SucceededSign({ signature })),
      Command.resolve(Submit, Message.SucceededSubmit({ transactionHash })),
      ...Array.makeBy(mostChecks, (attempt) => [
        Command.expectExact(WaitBeforeCheck({ attempt })),
        Command.resolve(WaitBeforeCheck, Message.CompletedWaitBeforeCheck()),
        attempt % 2 === 0
          ? Command.resolve(ReadMoneyJob, Message.SucceededReadJob({ view: moneyJob('accepted') }))
          : Command.resolve(ReadMoneyJob, Message.FailedReadJob({ problem: Problem.Unreachable() })),
      ]).flat(),
      model((money) => expect(money.flow).toEqual(Flow.GaveUp({ step: 'fund', transactionHash }))),
      Command.expectNone(),
      message(Message.ClickedCheckAgain()),
      Command.expectExact(ReadMoneyJob({ job: requestId })),
      Command.resolve(ReadMoneyJob, Message.SucceededReadJob({ view: moneyJob('funded') })),
      model((money) => expect(Flow.guards.Done(money.flow)).toBe(true)),
      Command.resolve(ReadPayment, Message.FailedReadPayment({ problem: Problem.Unavailable() })),
    )
  })
})

describe('delivering', () => {
  const deliver = Message.ClickedDeliver({ signer: workerWallet, buyer: buyerKey, network: arc })

  test('the worker says where the work is; the note is published, its hash signed and relayed, until delivered', () => {
    story(
      update,
      given(fresh),
      message(deliver),
      message(Message.SubmittedDelivery()),
      model((money) => expect(money.flow).toMatchObject({ _tag: 'EditingDelivery', status: FormStatus.Invalid() })),
      message(Message.UpdatedDeliveryUrl({ value: 'http://files.example/logo.svg' })),
      message(Message.SubmittedDelivery()),
      Command.expectNone(),
      message(Message.UpdatedDeliveryUrl({ value: ' https://files.example/logo.svg ' })),
      message(Message.UpdatedDeliveryNote({ value: 'The SVG and a PNG.' })),
      message(Message.SubmittedDelivery()),
      connectedAs(workerWallet),
      Command.expectExact(
        PublishDeliveryNote({
          job: requestId,
          buyer: buyerKey,
          network: arc,
          maybeUrl: Option.some('https://files.example/logo.svg'),
          maybeNote: Option.some('The SVG and a PNG.'),
        }),
      ),
      Command.resolve(
        PublishDeliveryNote,
        Message.SucceededPublishEvent({ maybeDeliveryHash: Option.some(deliveryHash) }),
      ),
      Command.expectExact(
        PrepareSignature({ job: requestId, step: 'deliver', maybeDeliveryHash: Option.some(deliveryHash) }),
      ),
      Command.resolve(
        PrepareSignature,
        Message.SucceededPrepare({ typedData: typedDataOn('Delivery'), maybeFunding: Option.none() }),
      ),
      Command.expectExact(SignTypedData({ signer: workerWallet, typedData: typedDataOn('Delivery') })),
      Command.resolve(SignTypedData, Message.SucceededSign({ signature })),
      Command.expectExact(
        Submit({
          job: requestId,
          work: Work.Deliver({
            buyer: buyerKey,
            network: arc,
            maybeUrl: Option.some('https://files.example/logo.svg'),
            maybeNote: Option.some('The SVG and a PNG.'),
          }),
          signer: workerWallet,
          signature,
          maybeDeliveryHash: Option.some(deliveryHash),
        }),
      ),
      ...followedTo('delivered', 1),
      model((money) => expect(money.flow).toEqual(Flow.Done({ step: 'deliver', transactionHash }))),
    )
  })

  test('a note the signer could not publish stops before the wallet is asked', () => {
    const failure = PublishFailure.SignerFailed({ reason: 'locked' })
    story(
      update,
      given(fresh),
      message(deliver),
      message(Message.UpdatedDeliveryNote({ value: 'Done.' })),
      message(Message.SubmittedDelivery()),
      connectedAs(workerWallet),
      Command.resolve(PublishDeliveryNote, Message.FailedPublishEvent({ failure })),
      model((money) =>
        expect(money.flow).toEqual(Flow.Failed({ step: 'deliver', failure: MoneyFailure.Unpublished({ failure }) })),
      ),
      Command.expectNone(),
    )
  })

  test('a wallet on another chain switches, then signs the delivery at once', () => {
    story(
      update,
      given(fresh),
      message(deliver),
      message(Message.UpdatedDeliveryNote({ value: 'Done.' })),
      message(Message.SubmittedDelivery()),
      connectedAs(workerWallet, 1),
      Command.resolve(
        PublishDeliveryNote,
        Message.SucceededPublishEvent({ maybeDeliveryHash: Option.some(deliveryHash) }),
      ),
      Command.resolve(
        PrepareSignature,
        Message.SucceededPrepare({ typedData: typedDataOn('Delivery'), maybeFunding: Option.none() }),
      ),
      model((money) => expect(Flow.guards.Ready(money.flow)).toBe(true)),
      Command.expectNone(),
      message(Message.ClickedSwitchNetwork()),
      Command.resolve(SwitchNetwork, Message.FailedSwitchNetwork({ problem: Problem.WalletRejected() })),
      model((money) =>
        expect(money.flow).toEqual(
          Flow.Failed({ step: 'deliver', failure: MoneyFailure.Failed({ problem: Problem.WalletRejected() }) }),
        ),
      ),
    )
  })
})

describe('approving and rejecting', () => {
  test('the buyer confirms, their wallet signs the approval the API prepared, and the page follows until released', () => {
    story(
      update,
      given(fresh),
      message(Message.ClickedApprove({ signer: buyerWallet })),
      model((money) => expect(Flow.guards.ConfirmingApproval(money.flow)).toBe(true)),
      Command.expectNone(),
      message(Message.ClickedConfirmApproval()),
      connectedAs(buyerWallet),
      Command.expectExact(PrepareSignature({ job: requestId, step: 'approve', maybeDeliveryHash: Option.none() })),
      Command.resolve(
        PrepareSignature,
        Message.SucceededPrepare({ typedData: typedDataOn('Approval'), maybeFunding: Option.none() }),
      ),
      Command.resolve(SignTypedData, Message.SucceededSign({ signature })),
      Command.expectExact(
        Submit({
          job: requestId,
          work: Work.Approve(),
          signer: buyerWallet,
          signature,
          maybeDeliveryHash: Option.none(),
        }),
      ),
      ...followedTo('released'),
    )
  })

  test('a rejection needs a reason, published on the record before the wallet signs it', () => {
    story(
      update,
      given(fresh),
      message(Message.ClickedReject({ signer: buyerWallet })),
      message(Message.UpdatedReason({ value: '   ' })),
      message(Message.SubmittedRejection()),
      model((money) => expect(money.flow).toMatchObject({ _tag: 'EditingRejection', status: FormStatus.Invalid() })),
      Command.expectNone(),
      message(Message.UpdatedReason({ value: ' The favicon set is missing. ' })),
      message(Message.SubmittedRejection()),
      connectedAs(buyerWallet),
      Command.expectExact(PublishRejectionReason({ job: requestId, reason: 'The favicon set is missing.' })),
      Command.resolve(PublishRejectionReason, Message.SucceededPublishEvent({ maybeDeliveryHash: Option.none() })),
      Command.expectExact(PrepareSignature({ job: requestId, step: 'reject', maybeDeliveryHash: Option.none() })),
      Command.resolve(
        PrepareSignature,
        Message.SucceededPrepare({ typedData: typedDataOn('Rejection'), maybeFunding: Option.none() }),
      ),
      Command.resolve(SignTypedData, Message.SucceededSign({ signature })),
      ...followedTo('rejected'),
      model((money) => expect(money.flow).toEqual(Flow.Done({ step: 'reject', transactionHash }))),
    )
  })

  test('nothing delivered: the API refuses to prepare the approval, and the page reads the job again', () => {
    const refused = MoneyFailure.Refused({ reason: 'NotDelivered', maybeDetail: Option.none() })
    story(
      update,
      given(fresh),
      message(Message.ClickedApprove({ signer: buyerWallet })),
      message(Message.ClickedConfirmApproval()),
      connectedAs(buyerWallet),
      Command.resolve(PrepareSignature, Message.FailedPrepare({ failure: refused })),
      model((money) => expect(money.flow).toEqual(Flow.Failed({ step: 'approve', failure: refused }))),
      message(Message.ClickedReadAgain()),
      Command.expectExact(ReadMoneyJob({ job: requestId })),
      Command.resolve(ReadMoneyJob, Message.SucceededReadJob({ view: moneyJob('funded') })),
      expectOutMessage(OutMessage.ReadJob({ view: moneyJob('funded') })),
      model((money) => expect(Flow.guards.Idle(money.flow)).toBe(true)),
    )
  })

  test('one step at a time: a click while a step is in flight starts nothing, and cancelling leaves only a form', () => {
    const connecting: Model = {
      ...fresh,
      flow: Flow.Connecting({ attempt: { work: Work.Approve(), signer: buyerWallet } }),
    }
    story(
      update,
      given(fresh),
      message(Message.ClickedApprove({ signer: buyerWallet })),
      message(Message.ClickedCancel()),
      model((money) => expect(Flow.guards.Idle(money.flow)).toBe(true)),
      Command.expectNone(),
    )
    story(
      update,
      given(connecting),
      message(Message.ClickedFund({ proposal: proposal.id, payer: buyerWallet })),
      message(Message.ClickedDeliver({ signer: workerWallet, buyer: buyerKey, network: arc })),
      message(Message.ClickedCancel()),
      model((money) => expect(Flow.guards.Connecting(money.flow)).toBe(true)),
      expectNoOutMessage(),
      Command.expectNone(),
      message(Message.FailedReadWalletAccount({ problem: Problem.NoWallet() })),
      model((money) =>
        expect(money.flow).toEqual(
          Flow.Failed({ step: 'approve', failure: MoneyFailure.Failed({ problem: Problem.NoWallet() }) }),
        ),
      ),
    )
  })
})
