import { Amount, UsdcOnArcTestnet } from '@sidequest/protocol'
import { Option } from 'effect'
import { Command, expectNoOutMessage, expectOutMessage, given, message, model, story } from 'foldkit/story'
import { describe, expect, test } from 'vitest'
import { FormStatus } from '../../../src/Forms.ts'
import { Me, Standing } from '../../../src/Me.ts'
import {
  Action,
  init,
  Message,
  OutMessage,
  PublishAccept,
  PublishProposal,
  PublishStatement,
  ReadJob,
  ReadNames,
  update,
} from '../../../src/page/job/Job.ts'
import * as Propose from '../../../src/page/job/Propose.ts'
import { Preload } from '../../../src/Preload.ts'
import { PublishFailure, PublishRefusal } from '../../../src/Publishing.ts'
import { bidderAccount, bidderKey, buyerKey, foldedJob, proposalFrom, requestId } from '../../Fixtures.ts'

const ready = (pubkey: string, wallets: ReadonlyArray<string> = []) =>
  Me.Ready({
    identity: { signerKind: 'nip07', pubkey },
    standing: Standing.Known({ maybeName: Option.none(), wallets }),
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
})
