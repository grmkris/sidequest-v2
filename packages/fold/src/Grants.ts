import type { EventId, PublicKey } from '@sidequest/nostr'
import type { ParsedEvent } from '@sidequest/nostr/vocabulary'
import type { GrantScope } from '@sidequest/protocol'
import { Option, Schema } from 'effect'
import type { GrantFact, JobEvent } from './JobInput.ts'

/**
 * Why the grant an event names (`sq-grant`) does not let it count as its operator's: the fold knows no such grant
 * (`unknownGrant`), the grant is for another agent key than the one that signed (`otherKey`), it lacks the scope the
 * event's action needs (`scopeMissing`), the event's `created_at` is before its `notBefore` or at or after its
 * `expiresAt` (`outsideWindow`), or its operator revoked it (`revoked`).
 */
export const GrantRefusal = Schema.Literals(['unknownGrant', 'otherKey', 'scopeMissing', 'outsideWindow', 'revoked'])
export type GrantRefusal = typeof GrantRefusal.Type

/**
 * Who an event counts as. `by: 'self'`: its signer, as for any key; `by: 'agent'`: `operator`, whose grant `grant`
 * authorised the agent key that signed it. An event naming a grant that does not authorise it counts as its signer's
 * own, with `grantRefusal` saying why.
 */
export interface Acting {
  readonly by: 'self' | 'agent'
  readonly operator: PublicKey | null
  readonly grant: EventId | null
  readonly grantRefusal: GrantRefusal | null
}

const self: Acting = { by: 'self', operator: null, grant: null, grantRefusal: null }

/**
 * The grants the fold knows, once each by id. A grant id is the hash of the signed grant, so two facts about it differ
 * only in `revoked`, and it is revoked when any of them says so: whichever arrived first, a revocation is never undone.
 */
export const grantsById = (facts: ReadonlyArray<GrantFact>): ReadonlyMap<EventId, GrantFact> => {
  const byId = new Map<EventId, GrantFact>()
  for (const fact of facts) {
    const known = byId.get(fact.grant)
    byId.set(fact.grant, known === undefined || fact.revoked ? fact : known)
  }
  return byId
}

/**
 * The scope an event's action needs from its grant: a proposal or a proposal's withdrawal `propose`, an accept, a
 * request's withdrawal or a rejection reason (the buyer's side of a hire) `accept`, a delivery note `deliver`. A
 * request or a review needs one no scope grants: it always counts as its signer's.
 */
export const scopeOf = (event: JobEvent): GrantScope | null => {
  switch (event.type) {
    case 'proposal':
      return 'propose'
    case 'accept':
      return 'accept'
    case 'deliveryNote':
      return 'deliver'
    case 'statement':
      return event.parsed.content.type === 'withdraw_proposal' ? 'propose' : 'accept'
    case 'request':
    case 'review':
      return null
  }
}

/** Whether `grant` is revoked; the funded proposal is judged with `revocation: 'ignored'` (see `actingOf`). */
type Revocation = 'counts' | 'ignored'

/** Why `grant` does not authorise `event` for `scope`, or `null` when it does. */
const refusalOf = (
  event: ParsedEvent<unknown>['event'],
  grant: GrantFact | undefined,
  scope: GrantScope,
  revocation: Revocation,
): GrantRefusal | null => {
  if (grant === undefined) return 'unknownGrant'
  if (grant.agent !== event.pubkey) return 'otherKey'
  if (!grant.scopes.includes(scope)) return 'scopeMissing'
  if (event.created_at < grant.notBefore || event.created_at >= grant.expiresAt) return 'outsideWindow'
  return revocation === 'counts' && grant.revoked ? 'revoked' : null
}

/**
 * Who `parsed` counts as, for an action needing `scope` (`null`: no grant can carry it). An event that names a grant
 * counts as that grant's operator's when the grant is by that operator to the key that signed the event, has the scope,
 * the event's `created_at` lies in its window, and it is not revoked.
 *
 * Revocation is judged by what is known, never by when it arrived: a revoked grant authorises nothing, not even what
 * its agent signed before the revocation, so the index's view is the same in any arrival order. A revoked agent's
 * accept stops counting (an accept is only a signal), and its proposal is no longer its operator's offer. Money is the
 * exception: the chain's state is never undone, so the funded proposal is judged with `revocation: 'ignored'`, and
 * keeps the operator it was funded for as the job's worker.
 */
export const actingOf = (
  parsed: ParsedEvent<unknown>,
  scope: GrantScope | null,
  grants: ReadonlyMap<EventId, GrantFact>,
  revocation: Revocation = 'counts',
): Acting =>
  Option.match(parsed.envelope.grant, {
    onNone: () => self,
    onSome: (named) => {
      if (scope === null) return self
      const grant = grants.get(named)
      const refusal = refusalOf(parsed.event, grant, scope, revocation)
      return refusal === null && grant !== undefined
        ? { by: 'agent', operator: grant.operator, grant: named, grantRefusal: null }
        : { ...self, grant: named, grantRefusal: refusal }
    },
  })

/** Whose an event is: its operator's when a grant authorised it, else its signer's. */
export const principalOf = (acting: Acting, parsed: ParsedEvent<unknown>): PublicKey =>
  acting.operator ?? parsed.event.pubkey

/** Each event's acting and principal, judged once per fold. */
export interface Judged {
  readonly acting: (parsed: ParsedEvent<unknown>) => Acting
  readonly principal: (parsed: ParsedEvent<unknown>) => PublicKey
}

/**
 * Judges every event of the bag against the grants. `funded`, the funded proposal's id, is judged with revocation
 * ignored (see `actingOf`).
 */
export const judge = (
  events: ReadonlyArray<JobEvent>,
  grants: ReadonlyMap<EventId, GrantFact>,
  funded?: EventId,
): Judged => {
  const byId = new Map<EventId, Acting>()
  for (const event of events) {
    const revocation = event.parsed.event.id === funded ? 'ignored' : 'counts'
    byId.set(event.parsed.event.id, actingOf(event.parsed, scopeOf(event), grants, revocation))
  }
  const acting = (parsed: ParsedEvent<unknown>) => byId.get(parsed.event.id) ?? self
  return { acting, principal: (parsed) => principalOf(acting(parsed), parsed) }
}
