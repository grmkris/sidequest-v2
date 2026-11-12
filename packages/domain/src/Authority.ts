import type { AccountId, GrantScope, UnixSeconds } from '@sidequest/protocol'
import { DateTime, Effect, Predicate } from 'effect'
import { AgentRevoked } from './AgentRevoked.rejection.ts'
import { CurrentActor } from './CurrentActor.context.ts'
import { GrantExpired } from './GrantExpired.rejection.ts'
import { MissingScope } from './MissingScope.rejection.ts'
import { NotPermitted, type Role } from './NotPermitted.rejection.ts'
import { PartyRequired } from './PartyRequired.rejection.ts'
import { PersonRequired } from './PersonRequired.rejection.ts'
import { SystemOnly } from './SystemOnly.rejection.ts'

/** The command's receive time in the escrow contract's unit. */
export const unixSeconds = (now: DateTime.Utc): UnixSeconds => Math.floor(DateTime.toEpochMillis(now) / 1000)

/** Every rejection {@link withScope} can return. */
export const scopedRejections = [PartyRequired, AgentRevoked, GrantExpired, MissingScope] as const

/** Every rejection {@link asPerson} can return. */
export const personRejections = [PartyRequired, PersonRequired] as const

/** The account a person acts as. Their agents and the system may not send the command. */
export const asPerson = Effect.fnUntraced(function* () {
  const actor = yield* CurrentActor
  if (Predicate.isTagged(actor, 'System')) return yield* new PartyRequired({ system: actor.name })
  if (actor.agent !== undefined) return yield* new PersonRequired({ agent: actor.agent.id })
  return actor.account
})

/**
 * The account a person acts as, directly or through an agent whose grant covers `scope`, is not revoked and has not
 * ended at `now`, the time the command arrived.
 */
export const withScope = Effect.fnUntraced(function* (scope: GrantScope, now: DateTime.Utc) {
  const actor = yield* CurrentActor
  if (Predicate.isTagged(actor, 'System')) return yield* new PartyRequired({ system: actor.name })
  const agent = actor.agent
  if (agent === undefined) return actor.account
  if (agent.revoked) return yield* new AgentRevoked({ agent: agent.id })
  const at = unixSeconds(now)
  if (at >= agent.expiresAt) return yield* new GrantExpired({ agent: agent.id, expiresAt: agent.expiresAt, now: at })
  if (!agent.scopes.includes(scope)) return yield* new MissingScope({ agent: agent.id, scope })
  return actor.account
})

/** Whether the system sent the command. */
export const sentBySystem = Effect.gen(function* () {
  return Predicate.isTagged(yield* CurrentActor, 'System')
})

/** Passes only for the system actor: `Record*` commands report what the chain reader verified. */
export const asSystem = Effect.fnUntraced(function* () {
  const actor = yield* CurrentActor
  if (!Predicate.isTagged(actor, 'System')) return yield* new SystemOnly({ account: actor.account })
})

/** Passes only when the acting account is the one holding `role` here. */
export const requireRole = (account: AccountId, holder: AccountId, role: typeof Role.Type) =>
  account === holder ? Effect.void : Effect.fail(new NotPermitted({ account, required: role }))
