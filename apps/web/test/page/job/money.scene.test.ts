import type { JobView } from '@sidequest/fold'
import { type EscrowPaymentStatus, EscrowRefusalReason } from '@sidequest/protocol'
import { Option } from 'effect'
import { Command, click, expect, given, label, role, scene, submit, text, type, withViewInputs } from 'foldkit/scene'
import { describe, test } from 'vitest'
import { Me, Standing } from '../../../src/Me.ts'
import { init, type Model, update } from '../../../src/page/job/Job.ts'
import { view } from '../../../src/page/job/JobPage.ts'
import { Flow, Message as MoneyMessage, MoneyFailure, Work } from '../../../src/page/job/money/message.ts'
import { ReadWalletAccount, Quote } from '../../../src/page/job/money/update.ts'
import { Preload } from '../../../src/Preload.ts'
import { bidderAccount, bidderKey, buyerKey, otherKey, requestId } from '../../Fixtures.ts'
import {
  buyerAccount,
  buyerWallet,
  escrow,
  moneyJob,
  otherWallet,
  payment,
  quote,
  transactionHash,
} from './MoneyFixtures.ts'

const page = withViewInputs(view, { timeZone: 'UTC', inboxConfigured: true })

/** Someone whose NIP-07 extension signs as `pubkey`, with `wallets` linked to it. */
const signingAs = (pubkey: string, wallets: ReadonlyArray<string> = []): Me =>
  Me.Ready({
    identity: { signerKind: 'nip07', pubkey },
    standing: Standing.Known({ maybeName: Option.none(), wallets, agents: [] }),
  })
const buyer = signingAs(buyerKey, [buyerAccount])
const worker = signingAs(bidderKey, [bidderAccount])

/** The job page as the server rendered `job`, for `me`, with its money flow at `flow`. */
const opened = (
  me: Me,
  job: JobView,
  flow: Flow = Flow.Idle(),
  maybePayment: Option.Option<EscrowPaymentStatus> = Option.none(),
): Model => {
  const model = init(
    'en',
    requestId,
    me,
    Option.some(
      Preload.Job({
        view: job,
        names: [
          { pubkey: buyerKey, name: 'Ada', walletVerified: true },
          { pubkey: bidderKey, name: 'Ben', walletVerified: true },
        ],
      }),
    ),
  ).model
  return { ...model, money: { ...model.money, flow, maybePayment } }
}

describe('the money panel', () => {
  test('the buyer reviews the slip: the amount, the fee split, the worker’s wallet and that this step binds', () => {
    scene(
      { update, view: page() },
      given(opened(buyer, moneyJob('accepted'))),
      expect(text(/You accepted the proposal from Ben for 250.00 USDC/u)).toExist(),
      click(role('button', { name: 'Review the payment' })),
      Command.resolve(
        ReadWalletAccount,
        MoneyMessage.SucceededReadWalletAccount({ connection: { address: buyerWallet, chainId: 5042002 } }),
      ),
      Command.resolve(
        Quote,
        MoneyMessage.SucceededPrepare({ typedData: quote.typedData, maybeFunding: Option.some(quote) }),
      ),
      expect(role('heading', { name: 'What you sign' })).toExist(),
      expect(text('250.00 USDC')).toExist(),
      expect(text(/This is the step that binds/u)).toExist(),
      expect(text(/that is 12.50 USDC, and the worker receives 237.50 USDC/u)).toExist(),
      expect(text('0x2222222222222222222222222222222222222222')).toExist(),
      expect(text(escrow)).toExist(),
      expect(role('button', { name: 'Sign and fund' })).toExist(),
    )
  })

  test('a wallet on another chain is asked to switch before the slip offers a signature', () => {
    const prepared = {
      work: Work.Fund({ proposal: quote.proposal }),
      signer: buyerWallet,
      connection: { address: buyerWallet, chainId: 1 },
      maybeDeliveryHash: Option.none(),
      typedData: quote.typedData,
      maybeFunding: Option.some(quote),
    }
    scene(
      { update, view: page() },
      given(opened(buyer, moneyJob('accepted'), Flow.Ready({ prepared }))),
      expect(text('Your wallet is on another network (chain 1). Switch it to Arc testnet to sign.')).toExist(),
      expect(role('button', { name: 'Switch to Arc testnet' })).toExist(),
      expect(role('button', { name: 'Sign and fund' })).not.toExist(),
    )
  })

  test('names the connected account and the one the step needs, before the wallet is asked for anything', () => {
    scene(
      { update, view: page() },
      given(
        opened(
          buyer,
          moneyJob('accepted'),
          Flow.WrongWallet({
            attempt: { work: Work.Fund({ proposal: quote.proposal }), signer: buyerWallet },
            connected: otherWallet,
          }),
        ),
      ),
      expect(text(/Your wallet is connected with another account than the one this step needs/u)).toExist(),
      expect(text(otherWallet)).toExist(),
      expect(text(buyerWallet)).toExist(),
      expect(role('button', { name: 'Try again' })).toExist(),
    )
  })

  test('every refusal gets its own sentence; an unlinked payer is led to link the wallet', () => {
    const sentences: Readonly<Record<EscrowRefusalReason, RegExp>> = {
      RequestNotIndexed: /does not hold this request as a valid one/u,
      ProposalNotIndexed: /does not hold this proposal for this job/u,
      ProposalForOtherBuyer: /names another buyer/u,
      ReceiverNotPayTo: /would not go to the wallet the proposal names/u,
      PayerNotLinked: /is not linked to your key/u,
      ProposalExpired: /This proposal has expired/u,
      ProposalWithdrawn: /The bidder withdrew this proposal/u,
      ProposalSuperseded: /The bidder revised this proposal/u,
      ProposalNotAuthorised: /An agent made this proposal without its operator's permission/u,
      AlreadyFunded: /This job is already funded/u,
      NotFunded: /is not funded yet/u,
      NotDelivered: /Nothing is delivered on chain yet/u,
      Unpayable: /cannot be paid through this network's escrow/u,
      ChainRefused: /The chain refused this step/u,
    }
    for (const reason of EscrowRefusalReason.literals) {
      const failure = MoneyFailure.Refused({ reason, maybeDetail: Option.some('Reverted') })
      scene(
        { update, view: page() },
        given(opened(buyer, moneyJob('accepted'), Flow.Failed({ step: 'fund', failure }))),
        expect(text('Funding stopped.')).toExist(),
        expect(text(sentences[reason])).toExist(),
      )
    }
    scene(
      { update, view: page() },
      given(
        opened(
          buyer,
          moneyJob('accepted'),
          Flow.Failed({
            step: 'fund',
            failure: MoneyFailure.Refused({ reason: 'PayerNotLinked', maybeDetail: Option.none() }),
          }),
        ),
      ),
      expect(role('link', { name: 'Link your wallet on the identity page' })).toHaveAttr(
        'href',
        `/identity?next=${encodeURIComponent(`/jobs/${requestId}`)}`,
      ),
    )
  })

  test('without a linked wallet the buyer is told to link one, and offered no funding', () => {
    scene(
      { update, view: page() },
      given(opened(signingAs(buyerKey), moneyJob('accepted'))),
      expect(text(/Funding needs a wallet linked to your key/u)).toExist(),
      expect(role('button', { name: 'Review the payment' })).not.toExist(),
      expect(role('button', { name: 'Fund this proposal' })).not.toExist(),
    )
  })

  test('the worker of a funded job delivers: where the work is, published and signed', () => {
    scene(
      { update, view: page() },
      given(opened(worker, moneyJob('funded'))),
      expect(text(/The escrow is funded. Deliver by/u)).toExist(),
      click(role('button', { name: 'Deliver the work' })),
      submit(role('form')),
      expect(text(/Give an address that starts with https:\/\//u)).toExist(),
      type(label('Where the buyer gets it'), 'https://files.example/logo.svg'),
      expect(role('button', { name: 'Publish and sign the delivery' })).toExist(),
    )
  })

  test('after a rejection everyone reads that an arbitrator will rule, and by when', () => {
    scene(
      { update, view: page() },
      given(opened(Me.NoSigner(), moneyJob('rejected'))),
      expect(text(/The buyer rejected the delivery on .+ An arbitrator will rule by .+; without a ruling/u)).toExist(),
      expect(text('Arbitration open')).toExist(),
      expect(text('Rejected')).toExist(),
    )
  })

  test('the buyer of a delivered job approves or rejects while the review window is open', () => {
    scene(
      { update, view: page() },
      given(opened(buyer, moneyJob('delivered'))),
      expect(text('Review window open')).toExist(),
      click(role('button', { name: 'Reject' })),
      expect(label('Why you reject it')).toExist(),
      click(role('button', { name: 'Cancel' })),
      click(role('button', { name: 'Approve and pay' })),
      expect(role('button', { name: 'Sign the approval' })).toExist(),
    )
  })

  test('a released job shows the worker’s part, the exact fee, the transactions, and the review form', () => {
    scene(
      { update, view: page() },
      given(opened(buyer, moneyJob('released'), Flow.Idle(), Option.some(payment(['fund', 'delivery', 'approval'])))),
      expect(text('The buyer approved the work, and the worker was paid.')).toExist(),
      expect(role('heading', { name: 'Payment' })).not.toExist(),
      expect(text('237.50 USDC')).toExist(),
      expect(text('12.50 USDC')).toExist(),
      expect(text('0.00 USDC')).toExist(),
      expect(role('list', { name: 'Transactions' })).toExist(),
      expect(text(transactionHash)).toExist(),
      expect(role('heading', { name: 'Your review' })).toExist(),
      expect(role('button', { name: 'Publish review' })).toExist(),
    )
  })

  test('the buyer may reclaim from the escrow directly once its authorization expired; the page names the contract', () => {
    const expired = moneyJob('funded', {
      deadlines: { deliveryOverdue: true, reviewWindowOpen: false, arbitrationOpen: false, reclaimable: true },
    })
    scene(
      { update, view: page() },
      given(opened(buyer, expired, Flow.Idle(), Option.some(payment(['fund'])))),
      expect(text(/you can take the money back yourself/u)).toExist(),
      expect(text(escrow)).toExist(),
      expect(text('Reclaimable by the buyer')).toExist(),
    )
  })

  test('someone with no part in the job sees no money panel', () => {
    scene(
      { update, view: page() },
      given(opened(signingAs(otherKey), moneyJob('funded'))),
      expect(role('heading', { name: 'Payment' })).not.toExist(),
      expect(role('heading', { name: 'On chain' })).toExist(),
    )
  })
})
