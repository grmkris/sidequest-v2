import { format } from '@sidequest/i18n'
import { Effect, Option, Schema } from 'effect'
import { Command, type Html, Submodel, type Update } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'
import { Language } from '../Language.ts'
import { shortNpub } from '../Names.ts'
import { Rooms } from '../Rooms.ts'
import { styled } from '../Styled.ts'
import { formatInstant, say } from '../Text.ts'
import * as Ui from '../Ui.ts'
import * as s from '../Ui.styles.ts'

// Anyone checks a disclosed room message here (ADR-0004, decision 6): the bundle alone proves that a key wrote a text
// at the time it gives, and nothing else of the room. The check runs in the browser; nothing is sent anywhere.

// MODEL

export const Checked = defineTaggedUnion({
  Unchecked: {},
  Checking: {},
  Verified: {
    author: Schema.String,
    createdAt: Schema.Int,
    text: Schema.String,
    maybeRoom: Schema.Option(Schema.String),
  },
  Refused: {},
  Unavailable: {},
})
export type Checked = typeof Checked.Type

export const Model = Schema.Struct({ language: Language, pasted: Schema.String, checked: Checked })
export type Model = typeof Model.Type

export const init = (language: Language): Model => ({ language, pasted: '', checked: Checked.Unchecked() })

// MESSAGE

export const Message = defineMessageUnion({
  UpdatedPasted: { value: Schema.String },
  SubmittedCheck: {},
  CompletedCheck: { checked: Checked },
})
export type Message = typeof Message.Type

// COMMAND

/** The pasted bundle, checked with nothing but itself. */
export const CheckDisclosure = Command.define('CheckDisclosure', {
  args: { pasted: Schema.String },
  messages: [Message.CompletedCheck],
  execute: ({ pasted }) =>
    Rooms.use((rooms) => rooms.verify(pasted)).pipe(
      Effect.map((maybeVerified) =>
        Option.match(maybeVerified, {
          onNone: () => Checked.Refused(),
          onSome: (verified) => Checked.Verified(verified),
        }),
      ),
      Effect.orElseSucceed(() => Checked.Unavailable()),
      Effect.map((checked) => Message.CompletedCheck({ checked })),
    ),
})

// UPDATE

export const update = (model: Model, message: Message): Update.Return<Model, Message, Rooms> =>
  Message.match<Update.Return<Model, Message, Rooms>>(message, {
    UpdatedPasted: ({ value }) => ({
      model: modifyFields(model, { pasted: () => value, checked: () => Checked.Unchecked() }),
    }),
    SubmittedCheck: () =>
      Checked.guards.Checking(model.checked)
        ? { model }
        : {
            model: modifyFields(model, { checked: () => Checked.Checking() }),
            commands: [CheckDisclosure({ pasted: model.pasted })],
          },
    CompletedCheck: ({ checked }) => ({ model: modifyFields(model, { checked: () => checked }) }),
  })

// VIEW

const result = (h: Html.HtmlBuilder<Message>, model: Model, timeZone: string) =>
  Checked.match(model.checked, {
    Unchecked: () => h.empty,
    Checking: () => Ui.waiting(h, say(model.language, 'evidence.checking')),
    Refused: () => Ui.notice(h, 'danger', [h.p([], [say(model.language, 'evidence.refused')])]),
    Unavailable: () => Ui.notice(h, 'danger', [h.p([], [say(model.language, 'room.unavailable.notLoaded')])]),
    Verified: ({ author, createdAt, text }) =>
      Ui.notice(h, 'done', [
        h.p([], [say(model.language, 'evidence.verified')]),
        Ui.facts(h, [
          Ui.fact(h, say(model.language, 'evidence.author'), h.span([h.Title(author)], [shortNpub(author)])),
          Ui.fact(h, say(model.language, 'evidence.time'), formatInstant(createdAt, model.language, timeZone)),
        ]),
        h.p(styled(h, s.data()), [text]),
      ]),
  })

export const view = Submodel.defineView<Model, Message, { readonly timeZone: string }>((model, { timeZone }, h) =>
  h.div(styled(h, s.page()), [
    Ui.pageHead(h, say(model.language, 'evidence.title'), [say(model.language, 'evidence.lede')]),
    h.form(
      [h.OnSubmit(Message.SubmittedCheck()), ...styled(h, s.form())],
      [
        Ui.textArea(h, {
          id: 'evidence-bundle',
          label: say(model.language, 'evidence.bundleLabel'),
          value: model.pasted,
          onInput: (value) => Message.UpdatedPasted({ value }),
        }),
        h.div(styled(h, s.actions()), [
          Ui.submit(h, {
            label: say(model.language, 'evidence.check'),
            busy: Checked.guards.Checking(model.checked),
          }),
        ]),
      ],
    ),
    result(h, model, timeZone),
    h.p(styled(h, s.meta()), [format(model.language, 'evidence.limits', {})]),
  ]),
)
