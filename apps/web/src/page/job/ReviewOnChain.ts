import { format } from '@sidequest/i18n'
import { Erc8004FeedbackCall, WalletAddress } from '@sidequest/protocol'
import { Duration, Effect, Option, Schedule, Schema } from 'effect'
import { Command, type Html, Submodel, type Update } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'
import { SidequestClient } from '../../Api.ts'
import type { Handlers } from '../../Handlers.ts'
import { Language } from '../../Language.ts'
import { failedWith, Problem } from '../../Problem.ts'
import { styled } from '../../Styled.ts'
import { say } from '../../Text.ts'
import * as Ui from '../../Ui.ts'
import * as s from '../../Ui.styles.ts'
import { Connection, Wallet } from '../../Wallet.ts'
import { sameAddress } from './money/message.ts'

// The person's counted review, posted to ERC-8004 by their own wallet (ADR-0007, decision 6, option b): the core
// prepares `giveFeedback` for the entry of the subject's feedback file this review makes, whose document's hash goes
// with it; the wallet that was the review's side of the escrow sends it and pays the gas. The registry needs nobody's
// authorisation but refuses the agent's owner. Nothing Sidequest counts depends on it.

// MODEL

/** The counted review the person may post, and whom it is about. */
export const Counted = Schema.Struct({ subject: Schema.String, review: Schema.String })
export type Counted = typeof Counted.Type

/** Where posting is. `Unregistered`: the subject has no verified identity, so the review has no entry to post. */
export const Posting = defineTaggedUnion({
  Idle: {},
  Connecting: Counted.fields,
  Preparing: { ...Counted.fields, signer: WalletAddress },
  Sending: { call: Erc8004FeedbackCall },
  Mining: { hash: Schema.String },
  Posted: {},
  Unregistered: {},
  WrongWallet: { expected: Schema.String },
  Failed: { problem: Problem },
})
export type Posting = typeof Posting.Type

export const Model = Schema.Struct({ language: Language, posting: Posting })
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  ClickedPost: Counted.fields,
  SucceededConnectWallet: { connection: Connection },
  FailedConnectWallet: { problem: Problem },
  SucceededPrepareFeedback: { call: Erc8004FeedbackCall },
  FailedPrepareFeedback: { unregistered: Schema.Boolean, problem: Problem },
  SucceededSendFeedback: { hash: Schema.String },
  FailedSendFeedback: { problem: Problem },
  SucceededAwaitFeedback: {},
  FailedAwaitFeedback: { problem: Problem },
})
export type Message = typeof Message.Type

// COMMAND

export const ConnectFeedbackWallet = Command.define('ConnectFeedbackWallet', {
  messages: [Message.SucceededConnectWallet, Message.FailedConnectWallet],
  execute: Effect.gen(function* () {
    const connection = yield* (yield* Wallet).connect
    return Message.SucceededConnectWallet({ connection })
  }).pipe(Effect.catch(failedWith(Message.FailedConnectWallet))),
})

/** The core prepares `giveFeedback` of the review's entry in the subject's feedback file. */
export const PrepareFeedback = Command.define('PrepareFeedback', {
  args: Counted.fields,
  messages: [Message.SucceededPrepareFeedback, Message.FailedPrepareFeedback],
  execute: ({ subject, review }) =>
    Effect.gen(function* () {
      const api = yield* (yield* SidequestClient).api
      const call = yield* api.erc8004.feedbackCall({ params: { pubkey: subject, review } })
      return Message.SucceededPrepareFeedback({ call })
    }).pipe(
      Effect.catchTag('NotIndexed', () =>
        Effect.succeed(Message.FailedPrepareFeedback({ unregistered: true, problem: Problem.Unavailable() })),
      ),
      Effect.catch(failedWith(({ problem }) => Message.FailedPrepareFeedback({ unregistered: false, problem }))),
    ),
})

export const SendFeedback = Command.define('SendFeedback', {
  args: { call: Erc8004FeedbackCall },
  messages: [Message.SucceededSendFeedback, Message.FailedSendFeedback],
  execute: ({ call }) =>
    Wallet.use((wallet) => wallet.sendTransaction(call.from, call)).pipe(
      Effect.map((hash) => Message.SucceededSendFeedback({ hash })),
      Effect.catch(failedWith(Message.FailedSendFeedback)),
    ),
})

class Pending extends Schema.TaggedError<Pending>()('Pending', {}) {}

/** Waits for the transaction to be mined, polling every two seconds for up to three minutes. */
export const AwaitFeedback = Command.define('AwaitFeedback', {
  args: { hash: Schema.String },
  messages: [Message.SucceededAwaitFeedback, Message.FailedAwaitFeedback],
  execute: ({ hash }) =>
    Wallet.use((wallet) => wallet.receiptLogs(hash)).pipe(
      Effect.flatMap(Option.match({ onNone: () => Effect.fail(new Pending()), onSome: Effect.succeed })),
      Effect.retry({
        schedule: Schedule.spaced(Duration.seconds(2)),
        times: 90,
        while: (error) => error instanceof Pending,
      }),
      Effect.as(Message.SucceededAwaitFeedback()),
      Effect.catch(failedWith(Message.FailedAwaitFeedback)),
    ),
})

// INIT

export type Services = SidequestClient | Wallet
type UpdateReturn = Update.Return<Model, Message, Services>

export const init = (language: Language): Model => ({ language, posting: Posting.Idle() })

// UPDATE

const withPosting = (model: Model, posting: Posting): Model => modifyFields(model, { posting: () => posting })
const failed = (model: Model, problem: Problem): UpdateReturn => ({
  model: withPosting(model, Posting.Failed({ problem })),
})

const idle = (posting: Posting) =>
  !Posting.guards.Connecting(posting) &&
  !Posting.guards.Preparing(posting) &&
  !Posting.guards.Sending(posting) &&
  !Posting.guards.Mining(posting)

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    ClickedPost: ({ subject, review }) =>
      idle(model.posting)
        ? { model: withPosting(model, Posting.Connecting({ subject, review })), commands: [ConnectFeedbackWallet()] }
        : { model },
    SucceededConnectWallet: ({ connection }) => {
      const posting = model.posting
      return Posting.guards.Connecting(posting)
        ? {
            model: withPosting(
              model,
              Posting.Preparing({ subject: posting.subject, review: posting.review, signer: connection.address }),
            ),
            commands: [PrepareFeedback({ subject: posting.subject, review: posting.review })],
          }
        : { model }
    },
    FailedConnectWallet: ({ problem }) => failed(model, problem),
    SucceededPrepareFeedback: ({ call }) => {
      const posting = model.posting
      if (!Posting.guards.Preparing(posting)) {
        return { model }
      }
      return sameAddress(posting.signer, call.from)
        ? { model: withPosting(model, Posting.Sending({ call })), commands: [SendFeedback({ call })] }
        : { model: withPosting(model, Posting.WrongWallet({ expected: call.from })) }
    },
    FailedPrepareFeedback: ({ unregistered, problem }) =>
      unregistered ? { model: withPosting(model, Posting.Unregistered()) } : failed(model, problem),
    SucceededSendFeedback: ({ hash }) =>
      Posting.guards.Sending(model.posting)
        ? { model: withPosting(model, Posting.Mining({ hash })), commands: [AwaitFeedback({ hash })] }
        : { model },
    FailedSendFeedback: ({ problem }) => failed(model, problem),
    SucceededAwaitFeedback: () => ({ model: withPosting(model, Posting.Posted()) }),
    FailedAwaitFeedback: ({ problem }) => failed(model, problem),
  } satisfies Handlers<Message, UpdateReturn>)

// VIEW

const postingNotice = (h: Html.HtmlBuilder<Message>, language: Language, posting: Posting) =>
  Posting.match(posting, {
    Idle: () => h.empty,
    Connecting: () => Ui.waiting(h, say(language, 'erc8004.waitingWallet')),
    Preparing: () => Ui.waiting(h, say(language, 'erc8004.waitingWallet')),
    Sending: () => Ui.waiting(h, say(language, 'erc8004.waitingWallet')),
    Mining: () => Ui.waiting(h, say(language, 'erc8004.post.mining')),
    Posted: () => Ui.notice(h, 'done', [h.p([], [say(language, 'erc8004.post.posted')])]),
    Unregistered: () => Ui.notice(h, 'neutral', [h.p([], [say(language, 'erc8004.post.unregistered')])]),
    WrongWallet: ({ expected }) =>
      Ui.notice(h, 'danger', [h.p([], [format(language, 'erc8004.post.wrongWallet', { address: expected })])]),
    Failed: ({ problem }) => Ui.problemNotice(h, language, problem),
  })

/** Posting the person's counted review, when they have one. */
export const view = Submodel.defineView<Model, Message, { readonly maybeCounted: Option.Option<Counted> }>(
  (model, { maybeCounted }, h) =>
    Option.match(maybeCounted, {
      onNone: () => h.empty,
      onSome: (counted) =>
        h.div(styled(h, s.section()), [
          h.h3([], [say(model.language, 'erc8004.post.title')]),
          h.p(styled(h, s.hint()), [say(model.language, 'erc8004.post.hint')]),
          h.div(styled(h, s.actions()), [
            Ui.button(h, {
              label: say(model.language, 'erc8004.post.button'),
              onClick: Message.ClickedPost(counted),
              busy: !idle(model.posting),
              disabled: Posting.guards.Posted(model.posting),
            }),
          ]),
          postingNotice(h, model.language, model.posting),
        ]),
    }),
)
