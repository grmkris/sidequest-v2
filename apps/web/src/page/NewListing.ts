import { IndexListingSlug } from '@sidequest/protocol'
import { Effect, Option, Random, Schema } from 'effect'
import { Command, Submodel, Update } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { modifyFields } from 'foldkit/struct'
import type { SidequestClient } from '../Api.ts'
import { signerOnly } from '../Gate.ts'
import { Me } from '../Me.ts'
import { PublishFailure, publishEvent, publishFailureNotice, publishFailureOf } from '../Publishing.ts'
import { AppRoute, identityHref } from '../route.ts'
import type { Signers } from '../Signer.ts'
import { styled } from '../Styled.ts'
import { say } from '../Text.ts'
import * as Ui from '../Ui.ts'
import * as s from '../Ui.styles.ts'
import * as ListingForm from './ListingForm.ts'

// A seller publishes a listing: a NIP-99 event their signer signs, which the index keeps under their key and the
// listing's slug. The slug is chosen once, from the title; a later version keeps it.

// MODEL

export const Model = Schema.Struct({
  form: ListingForm.Model,
  me: Me,
  maybeFailure: Schema.Option(PublishFailure),
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  GotListingFormMessage: { message: ListingForm.Message },
  SucceededPublishListing: { pubkey: Schema.String, slug: IndexListingSlug },
  FailedPublishListing: { failure: PublishFailure },
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({
  Published: { pubkey: Schema.String, slug: IndexListingSlug },
  SignerMissing: {},
})
export type OutMessage = typeof OutMessage.Type

// COMMAND

/** A slug from a title: its letters and digits in lowercase, words joined by hyphens, at most 40 characters. */
export const slugBase = (title: string): string => {
  const base = title
    .normalize('NFKD')
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, '-')
    .replaceAll(/^-+|-+$/gu, '')
    .slice(0, 40)
    .replace(/-+$/u, '')
  return base === '' ? 'listing' : base
}

/** Publishes a new listing under a fresh slug: the title's, and a random suffix so a second listing of the same title
 * never replaces the first. */
export const PublishListing = Command.define('PublishListing', {
  args: { draft: ListingForm.ListingDraft },
  messages: [Message.SucceededPublishListing, Message.FailedPublishListing],
  execute: ({ draft }) =>
    Effect.gen(function* () {
      const suffix = (yield* Random.nextIntBetween(0, 36 ** 4)).toString(36).padStart(4, '0')
      const slug = yield* Schema.decodeUnknownEffect(IndexListingSlug)(`${slugBase(draft.title)}-${suffix}`)
      const event = yield* publishEvent((kit, createdAt) =>
        kit.listingTemplate({ ...draft, slug, status: 'active', publishedAt: createdAt }, createdAt),
      )
      return Message.SucceededPublishListing({ pubkey: event.pubkey, slug })
    }).pipe(
      Effect.catch((error) => Effect.succeed(Message.FailedPublishListing({ failure: publishFailureOf(error) }))),
    ),
})

// INIT

export const init = (language: ListingForm.Model['language'], me: Me): Model => ({
  form: ListingForm.init(language),
  me,
  maybeFailure: Option.none(),
})

// UPDATE

type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, OutMessage, Signers | SidequestClient>

const foldForm = Update.foldChild({
  update: ListingForm.update,
  read: (model: Model) => Option.some(model.form),
  write: (model: Model, nextForm: ListingForm.Model) => modifyFields(model, { form: () => nextForm }),
  toParentMessage: (message) => Message.GotListingFormMessage({ message }),
  foldOutMessage: ListingForm.OutMessage.match<
    Update.StepWithOutMessage<Model, Message, OutMessage, Signers | SidequestClient>
  >({
    Submitted:
      ({ draft }) =>
      (model) =>
        Me.guards.Ready(model.me)
          ? { model: modifyFields(model, { maybeFailure: () => Option.none() }), commands: [PublishListing({ draft })] }
          : { model: modifyFields(model, { form: ListingForm.settled }), outMessage: OutMessage.SignerMissing() },
  }),
})

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    GotListingFormMessage: ({ message: formMessage }) => foldForm(model, formMessage),
    SucceededPublishListing: ({ pubkey, slug }) => ({
      model: init(model.form.language, model.me),
      outMessage: OutMessage.Published({ pubkey, slug }),
    }),
    FailedPublishListing: ({ failure }) => ({
      model: modifyFields(model, { form: ListingForm.settled, maybeFailure: () => Option.some(failure) }),
    }),
  })

// VIEW

export const view = Submodel.defineView<Model, Message>((model, h) => {
  const language = model.form.language
  const route = AppRoute.NewListing()
  return h.div(styled(h, s.page()), [
    Ui.pageHead(h, say(language, 'newListing.title'), [say(language, 'newListing.lede')]),
    signerOnly(h, { language, me: model.me, route }, () =>
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
        Option.match(model.maybeFailure, {
          onNone: () => h.empty,
          onSome: (failure) => publishFailureNotice(h, language, failure, identityHref(route)),
        }),
      ]),
    ),
  ])
})
