import { defaultPageSize, type Message, type RoomId, SidequestApi, SignedInAccount } from '@sidequest/protocol'
import { Effect } from 'effect'
import { HttpApiBuilder } from 'effect/http-api'
import { jobViewFor, roomsIn } from './JobAudience.ts'
import { type People, PeopleClients, signedIn } from './People.ts'

/** A message as members read it, from the `RoomMessages` stream's entry. */
const messageOf = ({ seq, author, agent, text }: Message & { readonly members: unknown }): Message =>
  agent === undefined ? { seq, author, text } : { seq, author, agent, text }

/**
 * A page of a room's messages after the sequence number `after`, from its `RoomMessages` stream, whose `validate`
 * admits only members. The stream holds one entry per message, appended in order, so an entry's place is its
 * message's `seq`; `next` is the one to read after for the next page, `null` after the last.
 */
export const messagesIn = (people: People, room: RoomId, after: number | undefined, limit = defaultPageSize) =>
  Effect.map(
    people.RoomMessages.list(room, after === undefined ? { take: limit } : { take: limit, after: `${after}` }),
    ({ entries, cursor }) => ({
      messages: entries.map(({ event }) => messageOf(event)),
      next: cursor === null ? null : Number(cursor),
    }),
  )

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
          const view = yield* jobViewFor(clients, params.job, { account: yield* SignedInAccount })
          return { rooms: roomsIn(params.job, view) }
        }),
      )
      .handle('messages', ({ params, query: { after, limit } }) =>
        asPerson.ask((people) => messagesIn(people, params.room, after, limit)),
      )
      .handle('post', ({ params, payload }) =>
        asPerson.send((people) => people.PostMessage({ target: params.room, ...payload })),
      )
      .handle('pause', ({ params }) => asPerson.send((people) => people.PauseAgents({ target: params.room })))
      .handle('resume', ({ params }) => asPerson.send((people) => people.ResumeAgents({ target: params.room })))
  }),
)
