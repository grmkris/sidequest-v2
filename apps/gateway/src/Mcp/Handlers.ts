import type { RateLimiter } from '@sidequest/serving/RateLimiter'
import { Effect, Option } from 'effect'
import { Core } from '../Core/Core.ts'
import type { Delegations } from '../Delegations/Delegations.ts'
import type { GrantGate } from '../Grants/GrantGate.ts'
import type { AgentKeys } from '../Keys/AgentKeys.ts'
import type { AgentRoomState } from '../Rooms/AgentRoomState.ts'
import { listRooms, readRoomMessages, sendRoomMessage, setInboxRelays } from '../Rooms/AgentRooms.ts'
import type { RoomNetwork } from '../Rooms/RoomNetwork.ts'
import { GatewaySettings } from '../Settings.ts'
import { acting, refusedByCore } from './Acting.ts'
import { GatewayToolkit, Refused } from './Tools.ts'
import { accept, deliver, deliveryDelegation, propose, withdrawProposal } from './WriteTools.ts'
import { x402Quote, x402Receipt } from './X402Tools.ts'
import type { ChallengeFetch } from '../X402/ChallengeFetch.ts'

/** The services every tool call runs with, captured once when the handlers are built. */
type ToolServices =
  | Core
  | GrantGate
  | RateLimiter
  | AgentKeys
  | Delegations
  | AgentRoomState
  | RoomNetwork
  | ChallengeFetch

/**
 * Every tool's handler. Reads need an active grant; writes, the scope their tool names. The registry is shared by
 * every request, so the services are captured when it is built and the caller is read from the request.
 */
export const GatewayHandlers = GatewayToolkit.toLayer(
  Effect.gen(function* () {
    const services = yield* Effect.context<ToolServices>()
    const core = yield* Core
    const { coreUrl } = yield* GatewaySettings
    const run = <A, E>(effect: Effect.Effect<A, E, ToolServices>) => Effect.provideContext(effect, services)
    /** A read the core answers, after the agent passed the gate; its error as the tool's refusal. */
    const read = <A>(answer: Effect.Effect<A, Parameters<typeof refusedByCore>[0]>) =>
      run(Effect.flatMap(acting(null), () => Effect.mapError(answer, refusedByCore)))
    const found = <A, B>(
      answer: Effect.Effect<Option.Option<A>, Parameters<typeof refusedByCore>[0]>,
      missing: Refused,
      shown: (value: A) => B,
    ) =>
      Effect.flatMap(read(answer), (value) =>
        Option.match(value, { onNone: () => Effect.fail(missing), onSome: (some) => Effect.succeed(shown(some)) }),
      )
    return GatewayToolkit.of({
      whoami: () => run(Effect.map(acting(null), ({ agent, operator, grant }) => ({ agent, operator, grant }))),
      search_listings: ({ text, tag, limit, cursor }) => read(core.listings({ q: text, tag, limit, cursor })),
      list_open_requests: ({ limit, cursor }) => read(core.openJobs({ limit, cursor })),
      get_job: ({ job }) => found(core.job(job), new Refused({ reason: 'UnknownJob' }), (view) => ({ job: view })),
      get_person: ({ pubkey }) =>
        found(core.person(pubkey), new Refused({ reason: 'UnknownPerson' }), (person) => ({ person })),
      payment_status: ({ job }) => Effect.map(read(core.payment(job)), (payment) => ({ payment })),
      propose: (input) => run(propose(input)),
      withdraw_proposal: (input) => run(withdrawProposal(input)),
      accept: (input) => run(accept(input)),
      deliver: (input) => run(deliver(input, coreUrl)),
      delivery_delegation: (input) => run(deliveryDelegation(input)),
      x402_quote: (input) => run(x402Quote(input)),
      x402_receipt: (input) => run(x402Receipt(input)),
      erc8004_identity: () =>
        run(
          Effect.gen(function* () {
            const { agent } = yield* acting(null)
            const person = yield* Effect.mapError(core.person(agent), refusedByCore)
            const files = `${coreUrl}/api/erc8004/agents/${agent}`
            return {
              agent,
              identities: Option.match(person, { onNone: () => [], onSome: ({ erc8004 }) => erc8004 }),
              registrationFile: `${files}/registration`,
              feedbackFile: `${files}/feedback`,
            }
          }),
        ),
      list_rooms: ({ job }) => run(listRooms(job)),
      read_room_messages: () => run(readRoomMessages),
      send_room_message: ({ room, text }) => run(sendRoomMessage(room, text)),
      set_inbox_relays: ({ relays }) => run(setInboxRelays(relays)),
    })
  }),
)
