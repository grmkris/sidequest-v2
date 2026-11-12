import { Connection, ConnectionId } from '@sidequest/protocol'
import { Effect, Option, Schema } from 'effect'
import { AsyncData, Command, type Update } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { modifyFields } from 'foldkit/struct'
import { SidequestClient } from '../Api.ts'
import { Language } from '../Language.ts'
import { failedWith, Problem } from '../Problem.ts'

// The apps a person connected to their agents over OAuth, each until they revoke it. Revoking ends every token the app
// holds at once.

// MODEL

const ConnectionList = AsyncData.Schema(Schema.Array(Connection), Problem)

export const Model = Schema.Struct({
  language: Language,
  connections: ConnectionList.schema,
  maybeRevoking: Schema.Option(ConnectionId),
  maybeProblem: Schema.Option(Problem),
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  SucceededListConnections: { connections: Schema.Array(Connection) },
  FailedListConnections: { problem: Problem },
  ClickedRevoke: { connection: ConnectionId },
  SucceededRevoke: {},
  FailedRevoke: { problem: Problem },
})
export type Message = typeof Message.Type

// COMMAND

export const ListConnections = Command.define('ListConnections', {
  messages: [Message.SucceededListConnections, Message.FailedListConnections],
  execute: Effect.gen(function* () {
    const api = yield* (yield* SidequestClient).api
    const { items } = yield* api.connect.connections()
    return Message.SucceededListConnections({ connections: items })
  }).pipe(Effect.catch(failedWith(Message.FailedListConnections))),
})

export const RevokeConnection = Command.define('RevokeConnection', {
  args: { connection: ConnectionId },
  messages: [Message.SucceededRevoke, Message.FailedRevoke],
  execute: ({ connection }) =>
    Effect.gen(function* () {
      const api = yield* (yield* SidequestClient).api
      yield* api.connect.disconnect({ params: { connection } })
      return Message.SucceededRevoke()
    }).pipe(Effect.catch(failedWith(Message.FailedRevoke))),
})

// INIT

type UpdateReturn = Update.Return<Model, Message, SidequestClient>

export const init = (language: Language, mayRead: boolean): UpdateReturn => {
  const model: Model = {
    language,
    connections: mayRead ? AsyncData.Loading() : AsyncData.Idle(),
    maybeRevoking: Option.none(),
    maybeProblem: Option.none(),
  }
  return mayRead ? { model, commands: [ListConnections()] } : { model }
}

// UPDATE

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    SucceededListConnections: ({ connections }) => ({
      model: modifyFields(model, { connections: () => ConnectionList.Success({ data: connections }) }),
    }),
    FailedListConnections: ({ problem }) => ({
      model: modifyFields(model, { connections: () => ConnectionList.Failure({ error: problem }) }),
    }),
    ClickedRevoke: ({ connection }) =>
      Option.isSome(model.maybeRevoking)
        ? { model }
        : {
            model: modifyFields(model, {
              maybeRevoking: () => Option.some(connection),
              maybeProblem: () => Option.none(),
            }),
            commands: [RevokeConnection({ connection })],
          },
    SucceededRevoke: () => ({
      model: modifyFields(model, { maybeRevoking: () => Option.none() }),
      commands: [ListConnections()],
    }),
    FailedRevoke: ({ problem }) => ({
      model: modifyFields(model, { maybeRevoking: () => Option.none(), maybeProblem: () => Option.some(problem) }),
    }),
  })
