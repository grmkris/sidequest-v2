import { Amount, ProposalId } from '@sidequest/protocol'
import { Option } from 'effect'
import { change, Command, expect, expectOutMessage, given, label, role, scene, submit, text, type } from 'foldkit/scene'
import { describe, test } from 'vitest'
import { init, Message, OutMessage, revising, SubmitProposal, update, view } from '../../../src/page/job/Propose.ts'
import { ben, job, proposal } from '../../Fixtures.ts'

describe('proposing on a request', () => {
  test('checks the offer, then sends it as terms in USDC on Arc testnet', () => {
    scene(
      { update, view },
      given(init('en', job)),
      submit(role('form')),
      Command.expectNone(),
      expect(text('List at least one thing you will deliver.')).toExist(),
      type(label('Title of your proposal'), 'A logo'),
      type(label('What you will deliver'), 'An SVG logo\n\nA PNG at 2048 px\n'),
      type(label('Price in USDC'), '300'),
      change(label('Deliver within'), '14'),
      submit(role('form')),
      Command.resolve(
        SubmitProposal({
          job,
          maybePrevious: Option.none(),
          offer: {
            title: 'A logo',
            deliverables: ['An SVG logo', 'A PNG at 2048 px'],
            amount: Amount.make('300000000'),
            deliveryDays: '14',
            reviewDays: '3',
            disputeDays: '2',
            arbitrationDays: '7',
          },
        }),
        Message.SucceededSubmitProposal({ proposal: ProposalId.make('proposal_01JQ000000000000000000BEN3') }),
      ),
      expectOutMessage(OutMessage.Proposed()),
    )
  })

  test('a new version starts from the newest one’s terms and names it as previous', () => {
    scene(
      { update, view },
      given(revising(init('en', job), proposal(ben, 2, '300000000', 'b'))),
      expect(label('Price in USDC')).toHaveValue('300.00'),
      expect(role('button', { name: 'Send version 3' })).toExist(),
      type(label('Price in USDC'), '280'),
      submit(role('form')),
      Command.expectExact(
        SubmitProposal({
          job,
          maybePrevious: Option.some(2),
          offer: {
            title: 'A logo, version 2',
            deliverables: ['An SVG logo', 'A PNG at 2048 px'],
            amount: Amount.make('280000000'),
            deliveryDays: '7',
            reviewDays: '3',
            disputeDays: '2',
            arbitrationDays: '7',
          },
        }),
      ),
      Command.resolve(
        SubmitProposal,
        Message.SucceededSubmitProposal({ proposal: ProposalId.make('proposal_01JQ000000000000000000BEN3') }),
      ),
    )
  })
})
