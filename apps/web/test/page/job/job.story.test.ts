import { Amount, UsdcOnArcTestnet } from '@sidequest/protocol'
import { Option } from 'effect'
import { AsyncData } from 'foldkit'
import { Command, expectNoOutMessage, expectOutMessage, given, message, model, story } from 'foldkit/story'
import { describe, expect, test } from 'vitest'
import { FormStatus } from '../../../src/Forms.ts'
import { Me, Standing } from '../../../src/Me.ts'
import {
  Action,
  init,
  Message,
  type Model,
  OutMessage,
  PublishAccept,
  PublishProposal,
  PublishReview,
  PublishStatement,
  ReadJob,
  ReadNames,
  update,
} from '../../../src/page/job/Job.ts'
import { Flow, Message as MoneyMessage, Work } from '../../../src/page/job/money/message.ts'
import { ReadWalletAccount, ReadMoneyJob, ReadPayment } from '../../../src/page/job/money/update.ts'
import * as Propose from '../../../src/page/job/Propose.ts'
import * as Review from '../../../src/page/job/Review.ts'
import { Preload } from '../../../src/Preload.ts'
import { Problem } from '../../../src/Problem.ts'
import { PublishFailure, PublishRefusal } from '../../../src/Publishing.ts'
import { bidderAccount, bidderKey, buyerKey, foldedJob, proposalFrom, requestId } from '../../Fixtures.ts'
import { buyerAccount, buyerWallet, moneyJob, payment } from './MoneyFixtures.ts'

const ready = (pubkey: string, wallets: ReadonlyArray<string> = []) =>
  Me.Ready({
    identity: { signerKind: 'nip07', pubkey },
    standing: Standing.Known({ maybeName: Option.none(), wallets, agents: [] }),
  })
const bidder = ready(bidderKey, [bidderAccount])
const buyer = ready(buyerKey)

const first = proposalFrom(bidderKey, 'e1', '250000000')
const shown = (proposals: ReadonlyArray<typeof first>) =>
  Preload.Job({ view: foldedJob({ stage: 'proposed', proposals }), names: [] })

/** The job page as the server rendered it, for `me`. */
const opened = (me: Me, proposals: ReadonlyArray<typeof first> = []) =>
  init('en', requestId, me, Option.some(shown(proposals))).model

const offer = (title: string, amount: string): Propose.Offer => ({
  title,
  deliverables: ['An SVG logo'],
  amount: Amount.make(amount),
  deliveryDays: '7',
  reviewDays: '3',
  disputeDays: '2',
  arbitrationDays: '7',
  validDays: '7',
})

const typedOffer = (title: string, amount: string) => [
  message(Message.GotProposeMessage({ message: Propose.Message.UpdatedTitle({ value: title }) })),
  message(Message.GotProposeMessage({ message: Propose.Message.UpdatedDeliverables({ value: 'An SVG logo' }) })),
  message(Message.GotProposeMessage({ message: Propose.Message.UpdatedAmount({ value: amount }) })),
  message(Message.GotProposeMessage({ message: Propose.Message.SubmittedProposal() })),
]

const readAgain = Command.resolve(
  ReadJob({ job: requestId, fresh: true }),
  Message.SucceededReadJob({ view: foldedJob() }),
)

describe('the job page', () => {
  test('reads the job and the names of everyone on it when the server did not', () => {
    const fresh = init('en', requestId, Me.NoSigner(), Option.none())
    expect(fresh.commands?.map((command) => command.name)).toEqual(['ReadJob'])
    story(
      update,
      given(fresh.model),
      message(Message.SucceededReadJob({ view: foldedJob({ stage: 'proposed', proposals: [first] }) })),
      Command.expectExact(ReadNames({ pubkeys: [buyerKey, bidderKey] })),
      Command.resolve(ReadNames, Message.SucceededReadNames({ names: [] })),
    )
  })

  test('a bidder with a linked wallet proposes, paid to that wallet, and reads the job again past the cache', () => {
    story(
      update,
      given(opened(bidder)),
      message(Message.ClickedPropose()),
      model((page) => expect(Option.isSome(page.maybePropose)).toBe(true)),
      ...typedOffer('A logo in two colours', '250'),
      Command.expectExact(
        PublishProposal({
          job: requestId,
          buyer: buyerKey,
          payTo: bidderAccount,
          offer: offer('A logo in two colours', '250000000'),
          maybePrevious: Option.none(),
        }),
      ),
      model((page) => expect(page.action).toEqual(Action.Publishing({ act: 'proposal' }))),
      Command.resolve(PublishProposal, Message.SucceededPublish({ act: 'proposal' })),
      model((page) => {
        expect(page.action).toEqual(Action.Published({ act: 'proposal' }))
        expect(page.maybePropose).toEqual(Option.none())
      }),
      readAgain,
    )
  })

  test('a bidder revises their proposal, naming it as the previous one, and withdraws it with a statement', () => {
    story(
      update,
      given(opened(bidder, [first])),
      message(Message.ClickedRevise({ proposal: first.id })),
      model((page) =>
        expect(Option.flatMap(page.maybePropose, (form) => form.maybePrevious)).toEqual(Option.some(first.id)),
      ),
      ...typedOffer('A logo in three colours', '300'),
      Command.expectExact(
        PublishProposal({
          job: requestId,
          buyer: buyerKey,
          payTo: bidderAccount,
          offer: offer('A logo in three colours', '300000000'),
          maybePrevious: Option.some(first.id),
        }),
      ),
      Command.resolve(PublishProposal, Message.SucceededPublish({ act: 'proposal' })),
      readAgain,
      message(Message.ClickedWithdraw({ proposal: first.id })),
      Command.expectExact(
        PublishStatement({
          job: requestId,
          maybeAbout: Option.some(first.id),
          type: 'withdraw_proposal',
          text: 'I withdraw this proposal.',
        }),
      ),
      Command.resolve(PublishStatement, Message.SucceededPublish({ act: 'withdraw' })),
      readAgain,
    )
  })

  test('without a linked wallet a bidder publishes no proposal', () => {
    story(
      update,
      given(opened(ready(bidderKey))),
      message(Message.ClickedPropose()),
      ...typedOffer('A logo', '250'),
      Command.expectNone(),
      model((page) => expect(page.action).toEqual(Action.Idle())),
    )
  })

  test('the buyer accepts one proposal after confirming, by its exact terms digest, on its network', () => {
    story(
      update,
      given(opened(buyer, [first])),
      message(Message.ClickedAccept({ proposal: first.id })),
      model((page) => expect(page.action).toEqual(Action.ConfirmingAccept({ proposal: first.id }))),
      Command.expectNone(),
      message(Message.ClickedConfirmAccept()),
      Command.expectExact(
        PublishAccept({
          job: requestId,
          proposal: first.id,
          termsDigest: first.content.termsDigest,
          worker: bidderKey,
          network: UsdcOnArcTestnet.network,
        }),
      ),
      Command.resolve(PublishAccept, Message.SucceededPublish({ act: 'accept' })),
      model((page) => expect(page.action).toEqual(Action.Published({ act: 'accept' }))),
      readAgain,
    )
  })

  test('the buyer closes the request with a withdraw_request statement, after confirming', () => {
    story(
      update,
      given(opened(buyer)),
      message(Message.ClickedClose()),
      model((page) => expect(page.action).toEqual(Action.ConfirmingClose())),
      message(Message.ClickedConfirmClose()),
      Command.expectExact(
        PublishStatement({
          job: requestId,
          maybeAbout: Option.none(),
          type: 'withdraw_request',
          text: 'I have closed this request.',
        }),
      ),
      Command.resolve(PublishStatement, Message.SucceededPublish({ act: 'close' })),
      readAgain,
    )
  })

  test('without a signer, every action leads to the identity page and publishes nothing', () => {
    for (const clicked of [
      Message.ClickedPropose(),
      Message.ClickedAccept({ proposal: first.id }),
      Message.ClickedWithdraw({ proposal: first.id }),
      Message.ClickedClose(),
    ]) {
      story(
        update,
        given(opened(Me.NoSigner(), [first])),
        message(clicked),
        expectOutMessage(OutMessage.SignerMissing()),
        model((page) => expect(page.action).toEqual(Action.Idle())),
        Command.expectNone(),
      )
    }
  })

  test('shows the index’s typed refusal, and the form can be sent again', () => {
    const refusal = PublishFailure.Refused({ refusal: PublishRefusal.RateLimited({ retryAfterSeconds: 30 }) })
    story(
      update,
      given(opened(bidder)),
      message(Message.ClickedPropose()),
      ...typedOffer('A logo', '250'),
      Command.resolve(PublishProposal, Message.FailedPublish({ failure: refusal })),
      expectNoOutMessage(),
      model((page) => {
        expect(page.action).toEqual(Action.Failed({ failure: refusal }))
        expect(Option.map(page.maybePropose, (form) => form.status)).toEqual(Option.some(FormStatus.Editing()))
      }),
    )
  })

  test('a job the server read funded asks for its payment, and so does every read that finds it funded', () => {
    const served = init('en', requestId, buyer, Option.some(Preload.Job({ view: moneyJob('funded'), names: [] })))
    expect(served.commands?.map((command) => command.name)).toEqual([ReadPayment.name])
    story(
      update,
      given(served.model),
      message(Message.SucceededReadJob({ view: moneyJob('delivered') })),
      Command.expectExact(ReadPayment({ job: requestId })),
      Command.resolve(ReadPayment, MoneyMessage.SucceededReadPayment({ status: payment(['fund']) })),
      model((page) => expect(Option.isSome(page.money.maybePayment)).toBe(true)),
    )
  })

  test('the buyer funds a proposal from its card, from the wallet linked to their key', () => {
    story(
      update,
      given(opened(ready(buyerKey, [buyerAccount]), [first])),
      message(Message.ClickedFund({ proposal: first.id, payer: buyerWallet })),
      Command.expectExact(ReadWalletAccount()),
      model((page) =>
        expect(page.money.flow).toEqual(
          Flow.Connecting({ attempt: { work: Work.Fund({ proposal: first.id }), signer: buyerWallet } }),
        ),
      ),
      Command.resolve(ReadWalletAccount, MoneyMessage.FailedReadWalletAccount({ problem: Problem.NoWallet() })),
    )
  })

  test('a job the money panel read while following a step is the job the page shows', () => {
    const following: Model = {
      ...opened(buyer, [first]),
      money: {
        ...opened(buyer, [first]).money,
        flow: Flow.Following({ step: 'fund', transactionHash: `0x${'7e'.repeat(32)}`, attempt: 0 }),
      },
    }
    story(
      update,
      given(following),
      message(Message.GotMoneyMessage({ message: MoneyMessage.CompletedWaitBeforeCheck() })),
      Command.resolve(ReadMoneyJob, MoneyMessage.SucceededReadJob({ view: moneyJob('funded') })),
      model((page) => expect(page.view).toEqual(AsyncData.Success({ data: moneyJob('funded') }))),
      Command.resolve(ReadPayment, MoneyMessage.SucceededReadPayment({ status: payment(['fund']) })),
      Command.expectNone(),
    )
  })

  test('once settled, a side reviews the other: the worker, from the buyer, with the rating and text they gave', () => {
    const settled = Preload.Job({ view: moneyJob('released'), names: [] })
    const page = init('en', requestId, ready(buyerKey, [buyerAccount]), Option.some(settled)).model
    story(
      update,
      given(page),
      message(Message.GotReviewMessage({ message: Review.Message.UpdatedText({ value: ' ' }) })),
      message(Message.GotReviewMessage({ message: Review.Message.SubmittedReview() })),
      Command.expectNone(),
      message(Message.GotReviewMessage({ message: Review.Message.SelectedRating({ value: '4' }) })),
      message(Message.GotReviewMessage({ message: Review.Message.UpdatedText({ value: ' On time, clean SVG. ' }) })),
      message(Message.GotReviewMessage({ message: Review.Message.SubmittedReview() })),
      Command.expectExact(
        PublishReview({ job: requestId, subject: bidderKey, rating: 4, text: 'On time, clean SVG.' }),
      ),
      model((current) => expect(current.action).toEqual(Action.Publishing({ act: 'review' }))),
      Command.resolve(PublishReview, Message.SucceededPublish({ act: 'review' })),
      model((current) => expect(current.review).toEqual(Review.init('en'))),
      readAgain,
    )
  })
})
