import { AsyncData } from 'foldkit'
import { modifyFields } from 'foldkit/struct'
import { Digest, type EscrowStatus } from '@sidequest/protocol'
import { Duration, Option } from 'effect'
import {
  changeFiles,
  Command,
  click,
  expect,
  expectOutMessage,
  given,
  label,
  role,
  scene,
  submit,
  text,
  type,
} from 'foldkit/scene'
import { describe, expect as assert, test } from 'vitest'
import {
  init,
  Message,
  OutMessage,
  pauseBefore,
  PrepareFunding,
  PrepareSignature,
  HashArtifact,
  ReadPayment,
  RecordDelivery,
  type Setup,
  SignTypedData,
  SubmitSignature,
  update,
  WaitBeforeCheck,
} from '../../../src/page/job/Settlement.ts'
import { view } from '../../../src/page/job/SettlementView.ts'
import { Problem } from '../../../src/Problem.ts'
import { escrow, fundingRequest, job, signature, termsFor, transaction, typedData, wallet } from '../../Fixtures.ts'

const setup = (side: Setup['role']): Setup => ({
  role: side,
  maybeSigner: Option.some(wallet),
  maybeTerms: Option.some(termsFor('A logo', '300000000')),
  maybeDeliveryUrl: Option.some('https://files.example/logo.zip'),
  maybeDisputeReason: Option.none(),
})

/** The panel once the chain reader answered with `status`. */
const at = (side: Setup['role'], status: EscrowStatus) =>
  modifyFields(init('en', job, setup(side)).model, { status: () => AsyncData.Success({ data: status }) })
const hash = Digest.make('a'.repeat(64))

const delivered = escrow('Delivered', {
  delivery: {
    deliveryHash: hash,
    deliveredAt: 1_800_000_000,
    reviewEndsAt: 1_800_259_200,
    transactionHash: transaction,
  },
})

describe('funding, for the buyer', () => {
  test('shows exactly what is signed before the wallet does, signs it, and follows the chain until it is funded', () => {
    scene(
      { update, view },
      given(at('buyer', escrow('Unfunded'))),
      click(role('button', { name: 'Review the payment' })),
      Command.resolve(
        PrepareFunding({ job, payer: wallet }),
        Message.SucceededPrepareFunding({ request: fundingRequest }),
      ),
      expect(role('heading', { name: 'What you sign' })).toExist(),
      expect(text('300.00 USDC')).toExist(),
      expect(text(fundingRequest.escrow)).toExist(),
      expect(text(fundingRequest.receiver)).toExist(),
      expect(text(fundingRequest.arbitrator)).toExist(),
      expect(text(/you have 3 days to approve or reject it/u)).toExist(),
      expect(text(/the arbitrator has 9 days to decide/u)).toExist(),
      expect(text(/If nothing is delivered by the deadline, everything comes back to you/u)).toExist(),
      expect(
        text(/5% goes to Sidequest: on the full amount that is 15\.00 USDC, and the worker receives 285\.00 USDC/u),
      ).toExist(),
      click(role('button', { name: 'Sign and fund' })),
      expect(text('Funding: confirm in your wallet…')).toExist(),
      Command.resolve(
        SignTypedData({ kind: 'fund', signer: wallet, typedData: fundingRequest.typedData }),
        Message.SucceededSignTypedData({ kind: 'fund', signature }),
      ),
      Command.resolve(
        SubmitSignature({ job, kind: 'fund', signature, maybeReason: Option.none() }),
        Message.SucceededSubmitSignature({ kind: 'fund', transactionHash: transaction }),
      ),
      expect(text(transaction)).toExist(),
      expect(text('Checking the chain again shortly…')).toExist(),
      Command.resolve(WaitBeforeCheck({ attempt: 0 }), Message.CompletedWaitBeforeCheck()),
      Command.resolve(ReadPayment({ job }), Message.SucceededReadPayment({ status: escrow('Unfunded') })),
      Command.resolve(WaitBeforeCheck({ attempt: 1 }), Message.CompletedWaitBeforeCheck()),
      Command.resolve(ReadPayment({ job }), Message.FailedReadPayment({ problem: Problem.Unavailable() })),
      Command.resolve(WaitBeforeCheck({ attempt: 2 }), Message.CompletedWaitBeforeCheck()),
      Command.resolve(ReadPayment({ job }), Message.SucceededReadPayment({ status: escrow('Funded') })),
      expectOutMessage(OutMessage.ChainMoved()),
      expect(text(/Funded\. The worker delivers by/u)).toExist(),
    )
  })

  test('a declined signature sends nothing and says so', () => {
    scene(
      { update, view },
      given(at('buyer', escrow('Unfunded'))),
      click(role('button', { name: 'Review the payment' })),
      Command.resolve(PrepareFunding, Message.SucceededPrepareFunding({ request: fundingRequest })),
      click(role('button', { name: 'Sign and fund' })),
      Command.resolve(SignTypedData, Message.FailedSignTypedData({ problem: Problem.WalletRejected() })),
      Command.expectNone(),
      expect(role('alert')).toContainText('You declined in your wallet. Nothing was signed.'),
      expect(role('button', { name: 'Review the payment' })).toExist(),
    )
  })

  test('a payment already submitted is followed rather than signed again', () => {
    scene(
      { update, view },
      given(at('buyer', escrow('Unfunded'))),
      click(role('button', { name: 'Review the payment' })),
      Command.resolve(
        PrepareFunding,
        Message.SucceededPrepareFunding({ request: { ...fundingRequest, state: 'submitted' } }),
      ),
      Command.expectExact(WaitBeforeCheck({ attempt: 0 })),
      expect(text('Funding: sent to the chain. The job moves on once the chain reader sees it confirmed.')).toExist(),
      Command.resolve(WaitBeforeCheck, Message.CompletedWaitBeforeCheck()),
      Command.resolve(ReadPayment, Message.SucceededReadPayment({ status: escrow('Funded') })),
      expectOutMessage(OutMessage.ChainMoved()),
    )
  })
})

describe('delivering, for the worker', () => {
  test('records the artifact’s address and hash, then signs the delivery the server prepared', () => {
    scene(
      { update, view },
      given(at('worker', escrow('Funded'))),
      click(role('button', { name: 'Deliver the work' })),
      type(label('Where the buyer gets it'), 'ftp://files.example/logo.zip'),
      type(label('SHA-256 of the delivered file'), 'not a hash'),
      submit(role('form')),
      Command.expectNone(),
      expect(text('Give an address that starts with https://.')).toExist(),
      type(label('Where the buyer gets it'), 'https://files.example/logo.zip'),
      type(label('SHA-256 of the delivered file'), hash.toUpperCase()),
      submit(role('form')),
      Command.resolve(
        RecordDelivery({ job, url: 'https://files.example/logo.zip', artifactHash: hash }),
        Message.SucceededRecordDelivery(),
      ),
      Command.resolve(
        PrepareSignature({ job, kind: 'deliver' }),
        Message.SucceededPrepareSignature({ kind: 'deliver', typedData }),
      ),
      Command.resolve(
        SignTypedData({ kind: 'deliver', signer: wallet, typedData }),
        Message.SucceededSignTypedData({ kind: 'deliver', signature }),
      ),
      Command.resolve(
        SubmitSignature({ job, kind: 'deliver', signature, maybeReason: Option.none() }),
        Message.SucceededSubmitSignature({ kind: 'deliver', transactionHash: transaction }),
      ),
      Command.resolve(WaitBeforeCheck({ attempt: 0 }), Message.CompletedWaitBeforeCheck()),
      Command.resolve(
        ReadPayment,
        Message.SucceededReadPayment({
          status: escrow('Delivered', {
            delivery: {
              deliveryHash: hash,
              deliveredAt: 1_800_000_000,
              reviewEndsAt: 1_800_259_200,
              transactionHash: transaction,
            },
          }),
        }),
      ),
      expectOutMessage(OutMessage.ChainMoved()),
      expect(text(/Delivered\. The buyer approves or rejects before the review ends/u)).toExist(),
    )
  })
})

describe('the delivered file’s hash', () => {
  test('is computed in the browser from a picked file and fills the field', () => {
    const file = new File(['logo'], 'logo.svg', { type: 'image/svg+xml' })
    scene(
      { update, view },
      given(at('worker', escrow('Funded'))),
      click(role('button', { name: 'Deliver the work' })),
      changeFiles(label('Compute it from a file'), [file]),
      Command.resolve(HashArtifact({ file }), Message.CompletedHashArtifact({ maybeHash: Option.some(hash) })),
      expect(label('SHA-256 of the delivered file')).toHaveValue(hash),
    )
  })
})

describe('reviewing the delivery, for the buyer', () => {
  test('shows the delivery and its review deadline, and approving signs the approval after saying what it does', () => {
    scene(
      { update, view },
      given(at('buyer', delivered)),
      expect(text('Review ends')).toExist(),
      expect(role('link', { name: 'https://files.example/logo.zip' })).toHaveAttr('rel', 'noopener noreferrer'),
      click(role('button', { name: 'Approve and pay' })),
      expect(text(/It can't be undone/u)).toExist(),
      click(role('button', { name: 'Sign the approval' })),
      Command.resolve(
        PrepareSignature({ job, kind: 'approve' }),
        Message.SucceededPrepareSignature({ kind: 'approve', typedData }),
      ),
      Command.resolve(
        SignTypedData({ kind: 'approve', signer: wallet, typedData }),
        Message.SucceededSignTypedData({ kind: 'approve', signature }),
      ),
      Command.resolve(
        SubmitSignature({ job, kind: 'approve', signature, maybeReason: Option.none() }),
        Message.SucceededSubmitSignature({ kind: 'approve', transactionHash: transaction }),
      ),
      Command.resolve(WaitBeforeCheck, Message.CompletedWaitBeforeCheck()),
      Command.resolve(
        ReadPayment,
        Message.SucceededReadPayment({
          status: escrow('Settled', {
            settlement: {
              outcome: 'Approved',
              workerShareBps: 10_000,
              settledAt: 1_800_100_000,
              receipts: [
                {
                  job,
                  rail: 'escrow',
                  network: 'eip155:5042002',
                  operation: 'capture',
                  asset: 'eip155:5042002/erc20:0x3600000000000000000000000000000000000000',
                  amount: '300000000',
                  payer: `eip155:5042002:${wallet}`,
                  payee: 'eip155:5042002:0x2222222222222222222222222222222222222222',
                  paymentHash: `0x${'ef'.repeat(32)}`,
                  transactionHash: transaction,
                  status: 'success',
                  confirmations: 3,
                },
              ],
            },
          }),
        }),
      ),
      expectOutMessage(OutMessage.ChainMoved()),
      expect(text('The buyer approved the work, and the worker was paid.')).toExist(),
      expect(text('Paid out 300.00 USDC')).toExist(),
    )
  })

  test('rejecting asks for the reason and sends it with the signed rejection', () => {
    scene(
      { update, view },
      given(at('buyer', delivered)),
      click(role('button', { name: 'Reject' })),
      expect(text(/Rejecting opens a dispute/u)).toExist(),
      submit(role('form')),
      Command.expectNone(),
      type(label('Why you reject it'), 'The colours are not the ones we agreed.'),
      click(role('button', { name: 'Sign the rejection' })),
      Command.resolve(
        PrepareSignature({ job, kind: 'reject' }),
        Message.SucceededPrepareSignature({ kind: 'reject', typedData }),
      ),
      Command.resolve(SignTypedData, Message.SucceededSignTypedData({ kind: 'reject', signature })),
      Command.expectExact(
        SubmitSignature({
          job,
          kind: 'reject',
          signature,
          maybeReason: Option.some('The colours are not the ones we agreed.'),
        }),
      ),
      Command.resolve(
        SubmitSignature,
        Message.FailedSubmitSignature({ problem: Problem.Conflict({ reason: 'ChainRefused' }) }),
      ),
      expect(role('alert')).toContainText('The chain would refuse this transaction, so it was not sent.'),
    )
  })
})

describe('reading the escrow', () => {
  test('waits for the chain reader before showing a step', () => {
    scene(
      { update, view },
      given(init('en', job, setup('buyer')).model),
      expect(text('Reading the escrow on Arc testnet…')).toExist(),
      expect(role('button', { name: 'Review the payment' })).not.toExist(),
    )
  })
})

describe('following the chain', () => {
  test('waits longer after each check, up to half a minute', () => {
    assert([0, 1, 2, 3, 4, 10].map((attempt) => Duration.toSeconds(pauseBefore(attempt)))).toEqual([
      2, 4, 8, 16, 30, 30,
    ])
  })
})
