import type { PublicKey } from '@sidequest/nostr'
import { emptyRoomState, type RoomAct, type RoomMessage, RoomState } from '@sidequest/nostr/rooms'
import type { Unavailable, UnixSeconds } from '@sidequest/protocol'
import { stored } from '@sidequest/serving/Stored'
import { Context, Effect, Layer, Match, Option, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'

// What the gateway keeps of an agent's rooms between tool calls, in its D1 (`migrations/0003_rooms.sql`): the room
// layer's state without a word anyone wrote. Texts are dropped, a carried proposal keeps only its kind, and seals are
// not kept, so the gateway cannot disclose a message later; it reads messages again from the relays when it needs them.

/** The act as stored: a text's words and a proposal's event are gone; an add or a remove keeps its member. */
const strippedAct = (act: RoomAct): RoomAct =>
  Match.valueTags(act, {
    Text: (): RoomAct => ({ _tag: 'Text' }),
    Add: (kept): RoomAct => kept,
    Remove: (kept): RoomAct => kept,
    Proposal: (): RoomAct => ({ _tag: 'Text' }),
  })

/** A message as stored: its place in the room and who wrote it, never what it says or the seal it came in. */
const strippedMessage = ({ seal: _seal, act, ...kept }: RoomMessage): RoomMessage => ({
  ...kept,
  act: strippedAct(act),
})

/** The state as the gateway stores it. */
export const strippedState = (state: RoomState): RoomState => ({
  ...state,
  messages: state.messages.map(strippedMessage),
})

const StateJson = Schema.fromJsonString(RoomState)
const encodeState = Schema.encodeSync(StateJson)
const decodeState = Schema.decodeUnknownOption(StateJson)

/** Agents' room state and pauses in the gateway's D1. */
export class AgentRoomState extends Context.Service<
  AgentRoomState,
  {
    readonly load: (agent: PublicKey) => Effect.Effect<RoomState, Unavailable>
    /** Keeps the state, stripped of every text, proposal and seal. */
    readonly save: (agent: PublicKey, state: RoomState, now: UnixSeconds) => Effect.Effect<void, Unavailable>
    readonly paused: (agent: PublicKey) => Effect.Effect<boolean, Unavailable>
    readonly setPaused: (agent: PublicKey, paused: boolean, now: UnixSeconds) => Effect.Effect<void, Unavailable>
  }
>()('Sidequest/Gateway/AgentRoomState') {
  /** On D1; needs the database's `SqlClient`. */
  static readonly layer = Layer.effect(
    AgentRoomState,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const stateOf = SqlSchema.findOneOption({
        Request: Schema.String,
        Result: Schema.Struct({ state: Schema.String }),
        execute: (agent) => sql`SELECT state FROM agent_rooms WHERE agent = ${agent}`,
      })
      const pauseOf = SqlSchema.findOneOption({
        Request: Schema.String,
        Result: Schema.Struct({ agent: Schema.String }),
        execute: (agent) => sql`SELECT agent FROM agent_pauses WHERE agent = ${agent}`,
      })
      return AgentRoomState.of({
        // A row that no longer decodes (an older shape) starts the agent over: it reads its rooms again from relays.
        load: (agent) =>
          Effect.map(stored(stateOf(agent)), (row) =>
            Option.getOrElse(
              Option.flatMap(row, ({ state }) => decodeState(state)),
              () => emptyRoomState,
            ),
          ),
        save: (agent, state, now) =>
          stored(sql`
            INSERT INTO agent_rooms (agent, state, updated_at) VALUES (${agent}, ${encodeState(strippedState(state))}, ${now})
            ON CONFLICT (agent) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`).pipe(
            Effect.asVoid,
          ),
        paused: (agent) => Effect.map(stored(pauseOf(agent)), Option.isSome),
        setPaused: (agent, paused, now) =>
          stored(
            paused
              ? sql`INSERT INTO agent_pauses (agent, paused_at) VALUES (${agent}, ${now}) ON CONFLICT (agent) DO NOTHING`
              : sql`DELETE FROM agent_pauses WHERE agent = ${agent}`,
          ).pipe(Effect.asVoid),
      })
    }),
  )
}
