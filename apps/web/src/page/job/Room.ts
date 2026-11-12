import { JobId, MessageSeq, MessageText, Message as RoomMessage, RoomId, RoomRef, webCrypto } from '@sidequest/protocol'
import { Array, Duration, Effect, Option, Schema, Stream } from 'effect'
import { AsyncData, Command, Subscription, type Update } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'
import { SidequestClient } from '../../Api.ts'
import type { Handlers } from '../../Handlers.ts'
import { Language } from '../../Language.ts'
import { Problem, problemOf } from '../../Problem.ts'

// The rooms of a job the person is a member of: a bidder's negotiation room, the job's engagement room. Read the
// messages (followed every few seconds while the room is open), write one, pause or resume your own agents.

// MODEL

const RoomList = AsyncData.Schema(Schema.Array(RoomRef), Problem)

/** Sending a message: its idempotency key is drawn once and kept until the message is accepted, so a retry after a
 * failure cannot post it twice. */
export const Send = defineTaggedUnion({
  Idle: {},
  Keyed: { key: Schema.String },
  Sending: { key: Schema.String },
  Failed: { key: Schema.String, problem: Problem },
})
export type Send = typeof Send.Type

/** What the person last did with their agents in this room. The API has no read of it, so only this session's action
 * is shown. */
export const Agents = defineTaggedUnion({
  Unknown: {},
  Pausing: {},
  Paused: {},
  Resuming: {},
  Resumed: {},
  Failed: { problem: Problem },
})
export type Agents = typeof Agents.Type

export const OpenRoom = Schema.Struct({
  room: RoomId,
  messages: Schema.Array(RoomMessage),
  reading: Schema.Boolean,
  maybeReadProblem: Schema.Option(Problem),
  draft: Schema.String,
  send: Send,
  agents: Agents,
})
export type OpenRoom = typeof OpenRoom.Type

export const Model = Schema.Struct({
  language: Language,
  job: JobId,
  rooms: RoomList.schema,
  maybeOpen: Schema.Option(OpenRoom),
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  SucceededListRooms: { rooms: Schema.Array(RoomRef) },
  FailedListRooms: { problem: Problem },
  SelectedRoom: { room: RoomId },
  SucceededReadMessages: { room: RoomId, messages: Schema.Array(RoomMessage), next: Schema.NullOr(MessageSeq) },
  FailedReadMessages: { room: RoomId, problem: Problem },
  TickedRoom: {},
  UpdatedDraft: { value: Schema.String },
  SubmittedMessage: {},
  CompletedDrawMessageKey: { key: Schema.String },
  SucceededPostMessage: { room: RoomId },
  FailedPostMessage: { room: RoomId, problem: Problem },
  ClickedPauseAgents: {},
  ClickedResumeAgents: {},
  SucceededSetAgents: { room: RoomId, paused: Schema.Boolean },
  FailedSetAgents: { room: RoomId, problem: Problem },
})
export type Message = typeof Message.Type

// COMMAND

export const ListRooms = Command.define('ListRooms', {
  args: { job: JobId },
  messages: [Message.SucceededListRooms, Message.FailedListRooms],
  execute: ({ job }) =>
    Effect.gen(function* () {
      const api = yield* (yield* SidequestClient).api
      const { rooms } = yield* api.rooms.list({ params: { job } })
      return Message.SucceededListRooms({ rooms })
    }).pipe(Effect.catch((error) => Effect.succeed(Message.FailedListRooms({ problem: problemOf(error) })))),
})

export const ReadMessages = Command.define('ReadMessages', {
  args: { room: RoomId, maybeAfter: Schema.Option(MessageSeq) },
  messages: [Message.SucceededReadMessages, Message.FailedReadMessages],
  execute: ({ room, maybeAfter }) =>
    Effect.gen(function* () {
      const api = yield* (yield* SidequestClient).api
      const read = yield* api.rooms.messages({ params: { room }, query: { after: Option.getOrUndefined(maybeAfter) } })
      return Message.SucceededReadMessages({ room, messages: read.messages, next: read.next })
    }).pipe(Effect.catch((error) => Effect.succeed(Message.FailedReadMessages({ room, problem: problemOf(error) })))),
})

/** A fresh idempotency key for one message. */
export const DrawMessageKey = Command.define('DrawMessageKey', {
  messages: [Message.CompletedDrawMessageKey],
  execute: webCrypto.randomULID.pipe(
    Effect.map((ulid) => Message.CompletedDrawMessageKey({ key: `web-${ulid}` })),
    Effect.catch(() => Effect.succeed(Message.CompletedDrawMessageKey({ key: 'web-fallback' }))),
  ),
})

export const PostMessage = Command.define('PostMessage', {
  args: { room: RoomId, text: MessageText, key: Schema.String },
  messages: [Message.SucceededPostMessage, Message.FailedPostMessage],
  execute: ({ room, text, key }) =>
    Effect.gen(function* () {
      const api = yield* (yield* SidequestClient).api
      yield* api.rooms.post({ params: { room }, payload: { text, key } })
      return Message.SucceededPostMessage({ room })
    }).pipe(Effect.catch((error) => Effect.succeed(Message.FailedPostMessage({ room, problem: problemOf(error) })))),
})

export const SetAgents = Command.define('SetAgents', {
  args: { room: RoomId, paused: Schema.Boolean },
  messages: [Message.SucceededSetAgents, Message.FailedSetAgents],
  execute: ({ room, paused }) =>
    Effect.gen(function* () {
      const api = yield* (yield* SidequestClient).api
      yield* paused ? api.rooms.pause({ params: { room } }) : api.rooms.resume({ params: { room } })
      return Message.SucceededSetAgents({ room, paused })
    }).pipe(Effect.catch((error) => Effect.succeed(Message.FailedSetAgents({ room, problem: problemOf(error) })))),
})

// INIT

type UpdateReturn = Update.Return<Model, Message, SidequestClient>

/** The rooms are read only for someone who may be signed in: they are for the job's members. */
export const init = (language: Language, job: JobId, mayRead: boolean): UpdateReturn =>
  mayRead
    ? { model: { language, job, rooms: AsyncData.Loading(), maybeOpen: Option.none() }, commands: [ListRooms({ job })] }
    : { model: { language, job, rooms: AsyncData.Idle(), maybeOpen: Option.none() } }

/** Ask for the rooms again, as a proposal or an award may have opened one. The open room stays open. */
export const refresh = (model: Model): UpdateReturn => ({ model, commands: [ListRooms({ job: model.job })] })

// UPDATE

const opened = (room: RoomId): OpenRoom => ({
  room,
  messages: [],
  reading: true,
  maybeReadProblem: Option.none(),
  draft: '',
  send: Send.Idle(),
  agents: Agents.Unknown(),
})

const openRoom = (model: Model, room: RoomId): UpdateReturn => ({
  model: modifyFields(model, { maybeOpen: () => Option.some(opened(room)) }),
  commands: [ReadMessages({ room, maybeAfter: Option.none() })],
})

/** A change to the open room, if it is still the room the result is about. */
const inRoom = (model: Model, room: RoomId, change: (open: OpenRoom) => OpenRoom): Model =>
  modifyFields(model, { maybeOpen: Option.map((open) => (open.room === room ? change(open) : open)) })

const lastSeq = (open: OpenRoom): Option.Option<number> => Option.map(Array.last(open.messages), (last) => last.seq)

/** The room to show first: the engagement room once the job is awarded, else the first negotiation. */
const firstRoom = (rooms: ReadonlyArray<RoomRef>): Option.Option<RoomId> =>
  Option.map(
    Option.orElse(
      Array.findFirst(rooms, (room) => room.kind === 'engagement'),
      () => Array.head(rooms),
    ),
    (room) => room.id,
  )

const readMore = (model: Model, room: RoomId, read: ReadonlyArray<RoomMessage>, next: number | null): UpdateReturn => {
  const nextModel = inRoom(model, room, (open) =>
    modifyFields(open, {
      messages: (messages) => Array.appendAll(messages, read),
      reading: () => next !== null,
      maybeReadProblem: () => Option.none(),
    }),
  )
  return next === null
    ? { model: nextModel }
    : { model: nextModel, commands: [ReadMessages({ room, maybeAfter: Option.some(next) })] }
}

type Group = Partial<Handlers<Message, UpdateReturn>>

const readHandlers = (model: Model) =>
  ({
    SucceededListRooms: ({ rooms }) =>
      Option.match(Option.isSome(model.maybeOpen) ? Option.none() : firstRoom(rooms), {
        onNone: () => ({ model: modifyFields(model, { rooms: () => RoomList.Success({ data: rooms }) }) }),
        onSome: (room) => openRoom(modifyFields(model, { rooms: () => RoomList.Success({ data: rooms }) }), room),
      }),
    FailedListRooms: ({ problem }) => ({
      model: modifyFields(model, { rooms: () => RoomList.Failure({ error: problem }) }),
    }),
    SelectedRoom: ({ room }) =>
      Option.exists(model.maybeOpen, (open) => open.room === room) ? { model } : openRoom(model, room),
    SucceededReadMessages: ({ room, messages, next }) => readMore(model, room, messages, next),
    FailedReadMessages: ({ room, problem }) => ({
      model: inRoom(model, room, (open) =>
        modifyFields(open, { reading: () => false, maybeReadProblem: () => Option.some(problem) }),
      ),
    }),
    TickedRoom: () =>
      Option.match(
        Option.filter(model.maybeOpen, (open) => !open.reading),
        {
          onNone: () => ({ model }),
          onSome: (open) => ({
            model: inRoom(model, open.room, (same) => modifyFields(same, { reading: () => true })),
            commands: [ReadMessages({ room: open.room, maybeAfter: lastSeq(open) })],
          }),
        },
      ),
  }) satisfies Group

const keyOf = (send: Send): Option.Option<string> =>
  Send.guards.Keyed(send) || Send.guards.Failed(send) ? Option.some(send.key) : Option.none()

const submitMessage = (model: Model): UpdateReturn =>
  Option.match(model.maybeOpen, {
    onNone: () => ({ model }),
    onSome: (open) => {
      const text = Schema.decodeUnknownOption(MessageText)(open.draft.trim())
      if (Send.guards.Sending(open.send) || Option.isNone(text)) {
        return { model }
      }
      return Option.match(keyOf(open.send), {
        onNone: () => ({ model, commands: [DrawMessageKey()] }),
        onSome: (key) => ({
          model: inRoom(model, open.room, (same) => modifyFields(same, { send: () => Send.Sending({ key }) })),
          commands: [PostMessage({ room: open.room, text: text.value, key })],
        }),
      })
    },
  })

const writeHandlers = (model: Model) =>
  ({
    UpdatedDraft: ({ value }) => ({
      model: modifyFields(model, { maybeOpen: Option.map((open) => modifyFields(open, { draft: () => value })) }),
    }),
    SubmittedMessage: () => submitMessage(model),
    CompletedDrawMessageKey: ({ key }) =>
      Option.match(model.maybeOpen, {
        onNone: () => ({ model }),
        onSome: (open) =>
          submitMessage(inRoom(model, open.room, (same) => modifyFields(same, { send: () => Send.Keyed({ key }) }))),
      }),
    SucceededPostMessage: ({ room }) => {
      const nextModel = inRoom(model, room, (open) =>
        modifyFields(open, { draft: () => '', send: () => Send.Idle(), reading: () => true }),
      )
      return Option.match(nextModel.maybeOpen, {
        onNone: () => ({ model: nextModel }),
        onSome: (open) => ({ model: nextModel, commands: [ReadMessages({ room, maybeAfter: lastSeq(open) })] }),
      })
    },
    FailedPostMessage: ({ room, problem }) => ({
      model: inRoom(model, room, (open) =>
        modifyFields(open, {
          send: (send) => (Send.guards.Sending(send) ? Send.Failed({ key: send.key, problem }) : send),
        }),
      ),
    }),
  }) satisfies Group

const setAgents = (model: Model, paused: boolean): UpdateReturn =>
  Option.match(model.maybeOpen, {
    onNone: () => ({ model }),
    onSome: (open) => ({
      model: inRoom(model, open.room, (same) =>
        modifyFields(same, { agents: () => (paused ? Agents.Pausing() : Agents.Resuming()) }),
      ),
      commands: [SetAgents({ room: open.room, paused })],
    }),
  })

const agentHandlers = (model: Model) =>
  ({
    ClickedPauseAgents: () => setAgents(model, true),
    ClickedResumeAgents: () => setAgents(model, false),
    SucceededSetAgents: ({ room, paused }) => ({
      model: inRoom(model, room, (open) =>
        modifyFields(open, { agents: () => (paused ? Agents.Paused() : Agents.Resumed()) }),
      ),
    }),
    FailedSetAgents: ({ room, problem }) => ({
      model: inRoom(model, room, (open) => modifyFields(open, { agents: () => Agents.Failed({ problem }) })),
    }),
  }) satisfies Group

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, { ...readHandlers(model), ...writeHandlers(model), ...agentHandlers(model) })

// SUBSCRIPTION

/** How often an open room asks for new messages. */
const followEvery = Duration.seconds(5)

/** While a room is open, a tick every few seconds; a read already on its way makes the tick do nothing. */
export const subscriptions = Subscription.make<Model, Message>()((entry) => ({
  follow: entry(
    { maybeRoom: Schema.Option(RoomId) },
    {
      modelToDependencies: (model) => ({ maybeRoom: Option.map(model.maybeOpen, (open) => open.room) }),
      dependenciesToStream: ({ maybeRoom }) =>
        Option.isNone(maybeRoom)
          ? Stream.empty
          : Stream.tick(followEvery).pipe(
              Stream.drop(1),
              Stream.map(() => Message.TickedRoom()),
            ),
    },
  ),
}))
