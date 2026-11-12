import { RoomTools } from '@sidequest/protocol'
import { Effect } from 'effect'
import { jobViewFor, roomsIn } from '../../Http/JobAudience.ts'
import { PeopleClients } from '../../Http/People.ts'
import { messagesIn } from '../../Http/RoomsHttp.ts'
import { currentCaller } from '../McpCaller.ts'
import { asAgent, trusted } from './AsAgent.ts'

/**
 * `list_rooms`, `get_room` and `send_message`: the rooms of the operator's view of a job, the `RoomMessages` stream
 * (whose `validate` admits only members), and `PostMessage` as the agent, which the room judges for its scope, its
 * operator's pause and the agents' turn limit.
 */
export const RoomHandlers = RoomTools.toLayer(
  Effect.gen(function* () {
    const clients = yield* PeopleClients
    return RoomTools.of({
      list_rooms: ({ job }) =>
        Effect.gen(function* () {
          const caller = yield* currentCaller
          return { rooms: roomsIn(job, yield* trusted(jobViewFor(clients, job, caller.actor))) }
        }),
      get_room: ({ room, after, limit }) =>
        Effect.flatMap(currentCaller, (caller) =>
          asAgent(clients, caller).ask((people) => messagesIn(people, room, after, limit)),
        ),
      send_message: ({ room, text, key }) =>
        Effect.gen(function* () {
          const caller = yield* currentCaller
          yield* asAgent(clients, caller).send((people) => people.PostMessage({ target: room, text, key }))
          return { room, key }
        }),
    })
  }),
)
