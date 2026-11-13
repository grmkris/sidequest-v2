import { Effect, Option, Schema } from 'effect'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import { Command, type Html, Submodel, type Update } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'
import { SidequestClient } from '../Api.ts'
import { Language } from '../Language.ts'
import { Rooms } from '../Rooms.ts'
import { styled } from '../Styled.ts'
import { say } from '../Text.ts'
import * as Ui from '../Ui.ts'
import * as s from '../Ui.styles.ts'

// Where a person receives private messages (NIP-17, kind 10050): without such a list nobody can write to them in a
// room. A person who has none is offered the stage's default inbox relays. A relay list is replaceable, so the page
// publishes one only after reading again, past every cache, that the index knows none: an existing list (10050), like
// the person's NIP-65 list (10002), which this page never publishes at all, is never replaced from here.

// MODEL

export const Action = defineTaggedUnion({
  Idle: {},
  Publishing: {},
  Published: {},
  AlreadyHad: {},
  Failed: {},
})
export type Action = typeof Action.Type

export const Model = Schema.Struct({ language: Language, defaults: Schema.Array(Schema.String), action: Action })
export type Model = typeof Model.Type

export const init = (language: Language, defaults: ReadonlyArray<string>): Model => ({
  language,
  defaults,
  action: Action.Idle(),
})

// MESSAGE

export const Message = defineMessageUnion({
  ClickedPublish: { pubkey: Schema.String },
  CompletedPublish: { outcome: Schema.Literals(['published', 'alreadyHad', 'failed']) },
})
export type Message = typeof Message.Type

/** The list is published, or one already was: the identity page reads the person again. */
export const OutMessage = defineMessageUnion({ Changed: {} })
export type OutMessage = typeof OutMessage.Type

// COMMAND

/** Reads the person again, fresh; signs and publishes the default list only when the index knows none. */
export const PublishInboxRelays = Command.define('PublishInboxRelays', {
  args: { pubkey: Schema.String, relays: Schema.Array(Schema.String) },
  messages: [Message.CompletedPublish],
  execute: ({ pubkey, relays }) =>
    Effect.gen(function* () {
      const api = yield* (yield* SidequestClient).api
      const person = yield* api.events.person({ params: { pubkey } }).pipe(
        Effect.provideService(FetchHttpClient.RequestInit, { cache: 'no-cache' }),
        Effect.map(Option.some),
        Effect.catchTag('NotIndexed', () => Effect.succeedNone),
      )
      if (Option.exists(person, (known) => known.messagingRelays !== null)) {
        return Message.CompletedPublish({ outcome: 'alreadyHad' })
      }
      const event = yield* (yield* Rooms).signInboxRelays(relays)
      yield* api.events.publish({ payload: event })
      return Message.CompletedPublish({ outcome: 'published' })
    }).pipe(Effect.catch(() => Effect.succeed(Message.CompletedPublish({ outcome: 'failed' })))),
})

// UPDATE

export const update = (
  model: Model,
  message: Message,
): Update.ReturnWithOutMessage<Model, Message, OutMessage, SidequestClient | Rooms> =>
  Message.match<Update.ReturnWithOutMessage<Model, Message, OutMessage, SidequestClient | Rooms>>(message, {
    ClickedPublish: ({ pubkey }) =>
      Action.guards.Publishing(model.action)
        ? { model }
        : {
            model: modifyFields(model, { action: () => Action.Publishing() }),
            commands: [PublishInboxRelays({ pubkey, relays: model.defaults })],
          },
    CompletedPublish: ({ outcome }) => {
      if (outcome === 'failed') {
        return { model: modifyFields(model, { action: () => Action.Failed() }) }
      }
      return {
        model: modifyFields(model, {
          action: () => (outcome === 'published' ? Action.Published() : Action.AlreadyHad()),
        }),
        outMessage: OutMessage.Changed(),
      }
    },
  })

// VIEW

/** The person's key and the inbox relays the index knows for it (none while unread). */
export type ViewInputs = { readonly pubkey: string; readonly maybeKnown: Option.Option<ReadonlyArray<string>> }

const notice = (h: Html.HtmlBuilder<Message>, model: Model) =>
  Action.match(model.action, {
    Idle: () => h.empty,
    Publishing: () => Ui.waiting(h, say(model.language, 'inboxRelays.publishing')),
    Published: () => Ui.notice(h, 'done', [h.p([], [say(model.language, 'inboxRelays.published')])]),
    AlreadyHad: () => Ui.notice(h, 'neutral', [h.p([], [say(model.language, 'inboxRelays.alreadyHad')])]),
    Failed: () => Ui.notice(h, 'danger', [h.p([], [say(model.language, 'inboxRelays.failed')])]),
  })

export const view = Submodel.defineView<Model, Message, ViewInputs>((model, { pubkey, maybeKnown }, h) => {
  const language = model.language
  const known = Option.getOrElse(maybeKnown, () => [])
  const offer =
    model.defaults.length === 0
      ? h.p(styled(h, s.meta()), [say(language, 'inboxRelays.notConfigured')])
      : h.div(styled(h, s.section()), [
          h.p([], [say(language, 'inboxRelays.offer')]),
          h.ul(
            styled(h, s.rows()),
            model.defaults.map((relay) => h.keyed('li')(relay, styled(h, s.row()), [Ui.dataText(h, relay)])),
          ),
          h.div(styled(h, s.actions()), [
            Ui.button(h, {
              label: say(language, 'inboxRelays.publish'),
              onClick: Message.ClickedPublish({ pubkey }),
              kind: 'primary',
              busy: Action.guards.Publishing(model.action),
            }),
          ]),
        ])
  return h.section(
    [h.AriaLabelledBy('inbox-relays'), ...styled(h, s.panel())],
    [
      h.h2([h.Id('inbox-relays')], [say(language, 'inboxRelays.title')]),
      h.p(styled(h, s.meta()), [say(language, 'inboxRelays.lede')]),
      known.length > 0
        ? h.ul(
            [h.AriaLabel(say(language, 'inboxRelays.yours')), ...styled(h, s.rows())],
            known.map((relay) => h.keyed('li')(relay, styled(h, s.row()), [Ui.dataText(h, relay)])),
          )
        : Option.isSome(maybeKnown)
          ? offer
          : h.empty,
      notice(h, model),
    ],
  )
})
