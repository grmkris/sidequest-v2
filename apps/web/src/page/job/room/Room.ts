import { Array, Duration, Effect, Option, Schema, Stream } from 'effect'
import { Command, Subscription, type Update } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'
import { Language } from '../../../Language.ts'
import { Delivered, Rooms, RoomsFailure, RoomsRead } from '../../../Rooms.ts'

// The job page's rooms (ADR-0004): the buyer's end-to-end encrypted conversation with each bidder, or a bidder's with
// the buyer. While the panel is open it reads the person's inbox relays every so often and whenever the window gains
// focus, one pass at a time, never in a loop; nothing of it passes through Sidequest's servers but the relay pipe,
// which carries ciphertext. This browser keeps the conversation (IndexedDB), and says so.

// MODEL

/** The longest message, in characters, the room layer carries. */
export const maxMessageLength = 5000

/** Who the rooms are between: the job's buyer, and the bidders whose rooms the person opens (the buyer: every bidder;
 * a bidder: themselves). */
export const Target = Schema.Struct({ job: Schema.String, buyer: Schema.String, bidders: Schema.Array(Schema.String) })
export type Target = typeof Target.Type

/** The panel: closed, opening (the first pass), unusable and why, or open. */
export const Panel = defineTaggedUnion({
  Closed: {},
  Opening: { target: Target },
  Unavailable: { reason: RoomsFailure },
  Open: { target: Target },
})
export type Panel = typeof Panel.Type

/** The message being written: being written, on its way, delivered to so many relays, or refused. */
export const Sending = defineTaggedUnion({
  Writing: {},
  Sending: {},
  Sent: { delivered: Delivered },
  Failed: { reason: RoomsFailure },
})
export type Sending = typeof Sending.Type

/** A message the person proves to someone else: its bundle, or why there is none. */
export const Evidence = defineTaggedUnion({
  None: {},
  Preparing: { message: Schema.String },
  Ready: { message: Schema.String, json: Schema.String },
  Failed: { message: Schema.String, reason: RoomsFailure },
})
export type Evidence = typeof Evidence.Type

export const Model = Schema.Struct({
  language: Language,
  panel: Panel,
  /** A pass over the inbox relays is under way: no second one starts. */
  polling: Schema.Boolean,
  maybeRead: Schema.Option(RoomsRead),
  maybeProblem: Schema.Option(RoomsFailure),
  /** The room shown, for a buyer with several. */
  maybeSelected: Schema.Option(Schema.String),
  draft: Schema.String,
  sending: Sending,
  evidence: Evidence,
  /** The room the person asked to forget on this device, waiting for their confirmation. */
  maybeForgetting: Schema.Option(Schema.String),
})
export type Model = typeof Model.Type

export const init = (language: Language): Model => ({
  language,
  panel: Panel.Closed(),
  polling: false,
  maybeRead: Option.none(),
  maybeProblem: Option.none(),
  maybeSelected: Option.none(),
  draft: '',
  sending: Sending.Writing(),
  evidence: Evidence.None(),
  maybeForgetting: Option.none(),
})

// MESSAGE

export const Message = defineMessageUnion({
  ClickedOpen: { target: Target },
  ClickedClose: {},
  TickedPoll: {},
  SucceededSync: { read: RoomsRead },
  FailedSync: { reason: RoomsFailure },
  SelectedRoom: { room: Schema.String },
  UpdatedDraft: { value: Schema.String },
  SubmittedMessage: {},
  SucceededSend: { delivered: Delivered },
  FailedSend: { reason: RoomsFailure },
  ClickedDisclose: { room: Schema.String, message: Schema.String },
  SucceededDisclose: { message: Schema.String, json: Schema.String },
  FailedDisclose: { message: Schema.String, reason: RoomsFailure },
  ClickedCloseEvidence: {},
  ClickedForget: { room: Schema.String },
  ClickedConfirmForget: {},
  ClickedKeep: {},
  CompletedForget: {},
})
export type Message = typeof Message.Type

// COMMAND

const reasonOf = (error: { readonly reason: RoomsFailure }) => error.reason

/** One pass over the person's inbox relays, and the job's rooms as they now read. */
export const SyncRooms = Command.define('SyncRooms', {
  args: { target: Target },
  messages: [Message.SucceededSync, Message.FailedSync],
  execute: ({ target }) =>
    Rooms.use((rooms) => rooms.sync(target)).pipe(
      Effect.map((read) => Message.SucceededSync({ read })),
      Effect.catch((error) => Effect.succeed(Message.FailedSync({ reason: reasonOf(error) }))),
    ),
})

/** The person's message into the room: one copy per member, each to that member's inbox relays. */
export const SendText = Command.define('SendText', {
  args: { room: Schema.String, text: Schema.String },
  messages: [Message.SucceededSend, Message.FailedSend],
  execute: ({ room, text }) =>
    Rooms.use((rooms) => rooms.sendText(room, text)).pipe(
      Effect.map((delivered) => Message.SucceededSend({ delivered })),
      Effect.catch((error) => Effect.succeed(Message.FailedSend({ reason: reasonOf(error) }))),
    ),
})

/** One message's disclosure bundle: its author's seal and that message's keys, nothing else. */
export const Disclose = Command.define('Disclose', {
  args: { room: Schema.String, message: Schema.String },
  messages: [Message.SucceededDisclose, Message.FailedDisclose],
  execute: ({ room, message }) =>
    Rooms.use((rooms) => rooms.disclose(room, message)).pipe(
      Effect.map((json) => Message.SucceededDisclose({ message, json })),
      Effect.catch((error) => Effect.succeed(Message.FailedDisclose({ message, reason: reasonOf(error) }))),
    ),
})

/** Forget a room's messages on this device; the relays keep their copies. */
export const ForgetRoom = Command.define('ForgetRoom', {
  args: { room: Schema.String },
  messages: [Message.CompletedForget],
  execute: ({ room }) =>
    Rooms.use((rooms) => rooms.forget(room)).pipe(Effect.ignore, Effect.as(Message.CompletedForget())),
})

// UPDATE

type UpdateReturn = Update.Return<Model, Message, Rooms>

const targetOf = (panel: Panel): Option.Option<Target> =>
  Panel.guards.Open(panel) || Panel.guards.Opening(panel) ? Option.some(panel.target) : Option.none()

/** A pass, unless one is under way or the panel is closed. */
const poll = (model: Model): UpdateReturn =>
  Option.match(targetOf(model.panel), {
    onNone: () => ({ model }),
    onSome: (target) =>
      model.polling
        ? { model }
        : { model: modifyFields(model, { polling: () => true }), commands: [SyncRooms({ target })] },
  })

/** The panel opens for these rooms, with a first pass. */
export const opened = (model: Model, target: Target): UpdateReturn =>
  poll(modifyFields(model, { panel: () => Panel.Opening({ target }), maybeProblem: () => Option.none() }))

/** Read again now: the person sent something into a room from elsewhere on the page. */
export const pollNow = (model: Model): UpdateReturn => poll(model)

/** The room shown: the one chosen, else the first. */
export const selectedRoom = (model: Model): Option.Option<string> =>
  Option.flatMap(model.maybeRead, (read) =>
    Option.orElse(
      Option.filter(model.maybeSelected, (room) => read.rooms.some((held) => held.room === room)),
      () => Option.map(Array.head(read.rooms), (held) => held.room),
    ),
  )

const synced = (model: Model, read: RoomsRead): Model =>
  modifyFields(model, {
    polling: () => false,
    maybeRead: () => Option.some(read),
    maybeProblem: () => Option.none(),
    panel: (panel) => (Panel.guards.Opening(panel) ? Panel.Open({ target: panel.target }) : panel),
  })

/** A failure that makes rooms unusable here (no signer, no NIP-44, no code) closes the panel; others are shown. */
const unusable = (reason: RoomsFailure) => reason === 'locked' || reason === 'noNip44' || reason === 'notLoaded'

const failedSync = (model: Model, reason: RoomsFailure): Model =>
  modifyFields(model, {
    polling: () => false,
    maybeProblem: () => Option.some(reason),
    panel: (panel) => (unusable(reason) ? Panel.Unavailable({ reason }) : panel),
  })

const textFits = (text: string) => text.trim().length > 0 && (text.match(/./gsu) ?? []).length <= maxMessageLength

const submitted = (model: Model): UpdateReturn => {
  if (Sending.guards.Sending(model.sending) || !textFits(model.draft)) {
    return { model }
  }
  return Option.match(selectedRoom(model), {
    onNone: () => ({ model }),
    onSome: (room) => ({
      model: modifyFields(model, { sending: () => Sending.Sending() }),
      commands: [SendText({ room, text: model.draft })],
    }),
  })
}

const forgetConfirmed = (model: Model): UpdateReturn =>
  Option.match(model.maybeForgetting, {
    onNone: () => ({ model }),
    onSome: (room) => ({
      model: modifyFields(model, { maybeForgetting: () => Option.none() }),
      commands: [ForgetRoom({ room })],
    }),
  })

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    ClickedOpen: ({ target }) => opened(model, target),
    ClickedClose: () => ({ model: modifyFields(model, { panel: () => Panel.Closed() }) }),
    TickedPoll: () => poll(model),
    SucceededSync: ({ read }) => ({ model: synced(model, read) }),
    FailedSync: ({ reason }) => ({ model: failedSync(model, reason) }),
    SelectedRoom: ({ room }) => ({ model: modifyFields(model, { maybeSelected: () => Option.some(room) }) }),
    UpdatedDraft: ({ value }) => ({
      model: modifyFields(model, {
        draft: () => value,
        sending: (sending) => (Sending.guards.Sending(sending) ? sending : Sending.Writing()),
      }),
    }),
    SubmittedMessage: () => submitted(model),
    SucceededSend: ({ delivered }) =>
      poll(modifyFields(model, { draft: () => '', sending: () => Sending.Sent({ delivered }) })),
    FailedSend: ({ reason }) => ({ model: modifyFields(model, { sending: () => Sending.Failed({ reason }) }) }),
    ClickedDisclose: ({ room, message: id }) => ({
      model: modifyFields(model, { evidence: () => Evidence.Preparing({ message: id }) }),
      commands: [Disclose({ room, message: id })],
    }),
    SucceededDisclose: ({ message: id, json }) => ({
      model: modifyFields(model, { evidence: () => Evidence.Ready({ message: id, json }) }),
    }),
    FailedDisclose: ({ message: id, reason }) => ({
      model: modifyFields(model, { evidence: () => Evidence.Failed({ message: id, reason }) }),
    }),
    ClickedCloseEvidence: () => ({ model: modifyFields(model, { evidence: () => Evidence.None() }) }),
    ClickedForget: ({ room }) => ({ model: modifyFields(model, { maybeForgetting: () => Option.some(room) }) }),
    ClickedConfirmForget: () => forgetConfirmed(model),
    ClickedKeep: () => ({ model: modifyFields(model, { maybeForgetting: () => Option.none() }) }),
    CompletedForget: () =>
      poll(modifyFields(model, { maybeRead: () => Option.none(), maybeSelected: () => Option.none() })),
  })

// SUBSCRIPTION

/** How often an open panel reads the inbox relays, besides whenever the window gains focus. */
export const pollEvery = Duration.seconds(15)

export const subscriptions = Subscription.make<Model, Message>()((entry) => ({
  roomPolling: entry(
    { open: Schema.Boolean },
    {
      modelToDependencies: (model) => ({ open: Option.isSome(targetOf(model.panel)) }),
      dependenciesToStream: ({ open }) =>
        Stream.when(
          Stream.merge(Stream.tick(pollEvery).pipe(Stream.drop(1)), Stream.fromEventListener(window, 'focus')).pipe(
            Stream.map(() => Message.TickedPoll()),
          ),
          Effect.sync(() => open),
        ),
    },
  ),
}))
