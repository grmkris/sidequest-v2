import { Option } from 'effect'
import { all, click, expect, expectAll, given, role, scene, text, withViewInputs } from 'foldkit/scene'
import { describe, test } from 'vitest'
import { Me, Standing } from '../../../src/Me.ts'
import { init, Message, update } from '../../../src/page/job/Job.ts'
import { view } from '../../../src/page/job/JobPage.ts'
import { Preload } from '../../../src/Preload.ts'
import { bidderAccount, bidderKey, buyerKey, foldedJob, otherKey, proposalFrom, requestId } from '../../Fixtures.ts'

const page = withViewInputs(view, { timeZone: 'UTC' })

const ready = (pubkey: string, wallets: ReadonlyArray<string> = []) =>
  Me.Ready({
    identity: { signerKind: 'nip07', pubkey },
    standing: Standing.Known({ maybeName: Option.none(), wallets }),
  })

const first = proposalFrom(bidderKey, 'e1', '250000000', { superseded: true })
const revision = proposalFrom(bidderKey, 'e2', '300000000', { accepted: true }, first.id)
const elsewhere = proposalFrom(otherKey, 'e3', '200000000', { withdrawn: true, otherBuyer: true })

const opened = (me: Me, extra: Parameters<typeof foldedJob>[0] = {}) =>
  init(
    'en',
    requestId,
    me,
    Option.some(
      Preload.Job({
        view: foldedJob({ stage: 'accepted', proposals: [first, revision, elsewhere], ...extra }),
        names: [
          { pubkey: buyerKey, name: 'Ada', walletVerified: true },
          { pubkey: bidderKey, name: 'Ben', walletVerified: true },
        ],
      }),
    ),
  ).model

describe('the job page', () => {
  test('shows each proposal with the fold’s labels, and its bidder by name or short npub', () => {
    scene(
      { update, view: page() },
      given(opened(Me.NoSigner())),
      expect(role('heading', { level: 1, name: 'A logo for my café' })).toExist(),
      expect(text('Proposal accepted')).toExist(),
      expect(text('Revised')).toExist(),
      expect(text('Accepted by the buyer')).toExist(),
      expect(text('Withdrawn')).toExist(),
      expect(text('For another buyer')).toExist(),
      expectAll(all.role('heading', { level: 3, name: 'From Ben' })).toHaveCount(2),
      expect(role('heading', { level: 3, name: /^From npub1/u })).toExist(),
    )
  })

  test('the buyer may accept only a proposal that still stands and is not accepted yet, and is told it is a signal', () => {
    scene(
      { update, view: page() },
      given(
        opened(ready(buyerKey), {
          stage: 'proposed',
          proposals: [
            proposalFrom(bidderKey, 'e1', '250000000', { superseded: true }),
            proposalFrom(bidderKey, 'e2', '300000000'),
          ],
        }),
      ),
      expectAll(all.role('button', { name: 'Accept this proposal' })).toHaveCount(1),
      click(role('button', { name: 'Accept this proposal' })),
      expect(text(/It is a signal, not a contract: nothing binds you or Ben until you fund the escrow/u)).toExist(),
      expect(role('button', { name: 'Close the request' })).toExist(),
    )
  })

  test('a bidder may revise and withdraw only their own proposal that stands, and waits for the buyer to fund', () => {
    scene(
      { update, view: page() },
      given(opened(ready(bidderKey, [bidderAccount]))),
      expectAll(all.role('button', { name: 'Revise' })).toHaveCount(1),
      expectAll(all.role('button', { name: 'Withdraw' })).toHaveCount(1),
      expect(role('button', { name: 'Accept this proposal' })).not.toExist(),
      expect(text('The buyer accepted your proposal. Start the work once they fund the escrow.')).toExist(),
      expect(role('button', { name: 'Make a proposal' })).toExist(),
    )
  })

  test('a person without a signer is led to the identity page, and one without a linked wallet is told why', () => {
    scene(
      { update, view: page() },
      given(opened(Me.NoSigner())),
      expect(role('link', { name: 'Set up your identity' })).toHaveAttr(
        'href',
        `/identity?next=${encodeURIComponent(`/jobs/${requestId}`)}`,
      ),
      expect(role('button', { name: 'Make a proposal' })).not.toExist(),
    )
    scene(
      { update, view: page() },
      given(opened(ready(otherKey))),
      expect(text('A proposal names the wallet you are paid to, so it needs a wallet linked to your key.')).toExist(),
      expect(role('button', { name: 'Make a proposal' })).not.toExist(),
    )
  })

  test('shows what the person published', () => {
    scene(
      { update, view: page() },
      given(update(opened(ready(buyerKey)), Message.SucceededPublish({ act: 'accept' })).model),
      expect(
        text('Your acceptance is published. It is a signal: nothing binds anyone until the escrow is funded.'),
      ).toExist(),
    )
  })
})
