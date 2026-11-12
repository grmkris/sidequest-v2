import { defaultPageSize, type Message, SidequestApi, SignedInAccount } from '@sidequest/protocol'
import { Effect } from 'effect'
import { HttpApiBuilder } from 'effect/http-api'
import { jobViewFor, roomsIn } from './JobAudience.ts'
import { PeopleClients, signedIn } from './People.ts'

/** A message as members read it, from the `RoomMessages` stream's entry. */
const messageOf = ({ seq, author, agent, text }: Message & { readonly members: unknown }): Message =>
  agent === undefined ? { seq, author, text } : { seq, author, agent, text }

/**
 * The `rooms` group: the rooms of a job, from the signed-in person's view of it, and in a room the messages, read from
 * the `RoomMessages` stream, whose `validate` admits only members, and the room's commands.
 */
export const roomsHandlers = HttpApiBuilder.group(SidequestApi, 'rooms', (handlers) =>
  Effect.gen(function* () {
    const clients = yield* PeopleClients
    const asPerson = signedIn(clients)
    return handlers
      .handle('list', ({ params }) =>
        Effect.gen(function* () {
          const view = yield* jobViewFor(clients, params.job, yield* SignedInAccount)
          return { rooms: roomsIn(params.job, view) }
        }),
      )
      .handle('messages', ({ params, query: { after, limit = defaultPageSize } }) =>
        Effect.map(
          asPerson.ask((people) =>
            people.RoomMessages.list(
              params.room,
              after === undefined ? { take: limit } : { take: limit, after: `${after}` },
            ),
          ),
          // A room's stream holds one entry per message, appended in order, so an entry's place is its message's `seq`.
          ({ entries, cursor }) => ({
            messages: entries.map(({ event }) => messageOf(event)),
            next: cursor === null ? null : Number(cursor),
          }),
        ),
      )
      .handle('post', ({ params, payload }) =>
        asPerson.send((people) => people.PostMessage({ target: params.room, ...payload })),
      )
      .handle('pause', ({ params }) => asPerson.send((people) => people.PauseAgents({ target: params.room })))
      .handle('resume', ({ params }) => asPerson.send((people) => people.ResumeAgents({ target: params.room })))
  }),
)
