import { Option } from 'effect'
import { Command, expectOutMessage, given, message, model, story } from 'foldkit/story'
import { describe, expect, test } from 'vitest'
import { FormStatus } from '../../src/Forms.ts'
import { Me, Standing } from '../../src/Me.ts'
import { init, Message, OutMessage, PublishRequest, update } from '../../src/page/NewRequest.ts'
import { PublishFailure, PublishRefusal } from '../../src/Publishing.ts'
import { buyerKey, requestId } from '../Fixtures.ts'

// A request needs a signer, not a linked wallet: this buyer has none.
const buyer = Me.Ready({
  identity: { signerKind: 'local', pubkey: buyerKey },
  standing: Standing.Known({ maybeName: Option.none(), wallets: [] }),
})

const filledIn = [
  message(Message.UpdatedTitle({ value: '  A logo for my café ' })),
  message(Message.UpdatedDescription({ value: 'Warm colours.' })),
  message(Message.SelectedDays({ value: '14' })),
]

describe('posting a request', () => {
  test('signs and publishes a request open for the days chosen, then goes to its job page', () => {
    story(
      update,
      given(init('en', buyer)),
      message(Message.SubmittedRequest()),
      model((page) => expect(page.status).toEqual(FormStatus.Invalid())),
      Command.expectNone(),
      ...filledIn,
      message(Message.SubmittedRequest()),
      Command.expectExact(PublishRequest({ title: 'A logo for my café', description: 'Warm colours.', days: '14' })),
      model((page) => expect(page.status).toEqual(FormStatus.Submitting())),
      Command.resolve(PublishRequest, Message.SucceededPublishRequest({ job: requestId })),
      expectOutMessage(OutMessage.Posted({ job: requestId })),
    )
  })

  test('without a signer, leads to the identity page and publishes nothing', () => {
    story(
      update,
      given(init('en', Me.NoSigner())),
      ...filledIn,
      message(Message.SubmittedRequest()),
      expectOutMessage(OutMessage.SignerMissing()),
      Command.expectNone(),
      model((page) => expect(page.status).toEqual(FormStatus.Editing())),
    )
  })

  test('shows the index’s typed refusal, and the request can be sent again', () => {
    const refused = PublishFailure.Refused({ refusal: PublishRefusal.Invalid({ reason: 'badContent' }) })
    story(
      update,
      given(init('en', buyer)),
      ...filledIn,
      message(Message.SubmittedRequest()),
      Command.resolve(PublishRequest, Message.FailedPublishRequest({ failure: refused })),
      model((page) => {
        expect(page.maybeFailure).toEqual(Option.some(refused))
        expect(page.status).toEqual(FormStatus.Editing())
      }),
      message(Message.SubmittedRequest()),
      Command.resolve(PublishRequest, Message.SucceededPublishRequest({ job: requestId })),
    )
  })
})
