import * as Domain from '@alchemy.run/domain'
import { AccountId } from '@sidequest/protocol'
import { Effect, Schema } from 'effect'
import { asViewer, viewerRejections } from '../Authority.ts'
import { NotPermitted } from '../NotPermitted.rejection.ts'
import { Session } from '../Session.middleware.ts'
import { Room } from './Room.aggregate.ts'

/** A room's members, and those of them who paused their agents here. */
export const PausedAgents = Schema.Struct({ members: Schema.Array(AccountId), paused: Schema.Array(AccountId) })
export type PausedAgents = typeof PausedAgents.Type

/**
 * Whose agents are paused in a room, for its members: each member reads whether their own agents may post. A room not
 * open yet has no members, so no one reads it.
 */
export class RoomPauses extends Domain.View('RoomPauses', {
  from: [Room],
  key: Room,
  middleware: [Session],
  rejects: [...viewerRejections, NotPermitted],
  state: PausedAgents,
  initial: { members: [], paused: [] },
  evolve: {
    RoomOpened: (view, { members }) => ({ ...view, members: [...members] }),
    AgentsPaused: (view, { member }) => ({ ...view, paused: [...view.paused, member] }),
    AgentsResumed: (view, { member }) => ({ ...view, paused: view.paused.filter((paused) => paused !== member) }),
  },
  validate: Effect.fn(function* (_request, view) {
    const account = yield* asViewer()
    if (view === null || !view.members.includes(account))
      return yield* new NotPermitted({ account, required: 'member' })
  }),
}) {}
