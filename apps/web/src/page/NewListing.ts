import { ListingDetails, ListingId } from '@sidequest/protocol'
import { Effect, Option, Schema } from 'effect'
import { Command, Submodel, Update } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { modifyFields } from 'foldkit/struct'
import { SidequestClient } from '../Api.ts'
import { signedInOnly } from '../Gate.ts'
import type { Language } from '../Language.ts'
import { Problem, problemOf } from '../Problem.ts'
import { AppRoute } from '../route.ts'
import type { Session } from '../Session.ts'
import { styled } from '../Styled.ts'
import { say } from '../Text.ts'
import * as Ui from '../Ui.ts'
import * as s from '../Ui.styles.ts'
import * as ListingForm from './ListingForm.ts'

// A seller publishes a listing: what they offer, its tags and a price hint.

// MODEL

export const Model = Schema.Struct({ form: ListingForm.Model })
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  GotListingFormMessage: { message: ListingForm.Message },
  SucceededPublishListing: { listing: ListingId },
  FailedPublishListing: { problem: Problem },
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({ Published: { listing: ListingId } })
export type OutMessage = typeof OutMessage.Type

// COMMAND

export const PublishListing = Command.define('PublishListing', {
  args: { details: ListingDetails },
  messages: [Message.SucceededPublishListing, Message.FailedPublishListing],
  execute: ({ details }) =>
    Effect.gen(function* () {
      const api = yield* (yield* SidequestClient).api
      const { id } = yield* api.listings.publish({ payload: details })
      return Message.SucceededPublishListing({ listing: id })
    }).pipe(Effect.catch((error) => Effect.succeed(Message.FailedPublishListing({ problem: problemOf(error) })))),
})

// INIT

export const init = (language: Language): Model => ({ form: ListingForm.init(language) })

// UPDATE

type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, OutMessage, SidequestClient>

const foldForm = Update.foldChild({
  update: ListingForm.update,
  read: (model: Model) => Option.some(model.form),
  write: (model: Model, nextForm: ListingForm.Model) => modifyFields(model, { form: () => nextForm }),
  toParentMessage: (message) => Message.GotListingFormMessage({ message }),
  foldOutMessage: ListingForm.OutMessage.match<Update.Step<Model, Message, SidequestClient>>({
    Submitted:
      ({ details }) =>
      (model) => ({ model, commands: [PublishListing({ details })] }),
  }),
})

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    GotListingFormMessage: ({ message: formMessage }) => foldForm(model, formMessage),
    SucceededPublishListing: ({ listing }) => ({
      model: init(model.form.language),
      outMessage: OutMessage.Published({ listing }),
    }),
    FailedPublishListing: ({ problem }) => ({
      model: modifyFields(model, { form: (form) => ListingForm.refused(form, problem) }),
    }),
  })

// VIEW

export const view = Submodel.defineView<Model, Message, { readonly session: Session }>((model, { session }, h) => {
  const language = model.form.language
  return h.div(styled(h, s.page()), [
    Ui.pageHead(h, say(language, 'newListing.title'), [say(language, 'newListing.lede')]),
    signedInOnly(h, { language, session, route: AppRoute.NewListing() }, () =>
      h.section(styled(h, s.panel()), [
        h.submodel({
          slotId: 'listing-form',
          model: model.form,
          view: ListingForm.view,
          viewInputs: {
            submitLabel: say(language, 'newListing.publish'),
            submittingLabel: say(language, 'newListing.publishing'),
          },
          toParentMessage: (message) => Message.GotListingFormMessage({ message }),
        }),
      ]),
    ),
  ])
})
