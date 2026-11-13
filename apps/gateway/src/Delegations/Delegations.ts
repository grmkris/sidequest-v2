import type { PublicKey } from '@sidequest/nostr'
import { evmAddressOf } from '@sidequest/nostr/vocabulary'
import type { Unavailable, UnixSeconds } from '@sidequest/protocol'
import { stored } from '@sidequest/serving/Stored'
import { Context, Effect, Layer, Option, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'

/**
 * A delegation the gateway holds for one agent and one job: the operator's wallet signature of
 * `DeliveryDelegate(paymentInfoHash, delegate, expiry)` and its expiry. The wallet's key never reaches the gateway.
 */
export const HeldDelegation = Schema.Struct({ signature: Schema.String, expiry: Schema.Int })
export type HeldDelegation = typeof HeldDelegation.Type

/**
 * The EVM address an agent signs deliveries as: its Nostr key's EVM key (`@sidequest/nostr`'s `evmAddressOf`, the
 * even-y point of its x-only public key), the `delegate` an operator's wallet names. Every key the gateway made has
 * one; `None` only for 32 bytes that are no point's x, which no agent's key is.
 */
export const delegateOf = (agent: PublicKey): Option.Option<`0x${string}`> => evmAddressOf(agent)

/**
 * Delivery delegations in the gateway's D1, one per agent and job. An operator stores one for their own agent (the
 * operator API checks that), the `deliver` tool reads it to record the delivery on chain unattended, and deleting the
 * agent forgets them all.
 */
export class Delegations extends Context.Service<
  Delegations,
  {
    readonly store: (
      operator: PublicKey,
      agent: PublicKey,
      job: string,
      delegation: HeldDelegation,
      now: UnixSeconds,
    ) => Effect.Effect<void, Unavailable>
    readonly find: (agent: PublicKey, job: string) => Effect.Effect<Option.Option<HeldDelegation>, Unavailable>
    /** Forgets the agent's delegation for the job; answers whether there was one. */
    readonly remove: (agent: PublicKey, job: string) => Effect.Effect<boolean, Unavailable>
  }
>()('Sidequest/Gateway/Delegations') {
  /** On D1 (`delivery_delegations`); needs the database's `SqlClient`. */
  static readonly layer = Layer.effect(
    Delegations,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const held = SqlSchema.findOneOption({
        Request: Schema.Struct({ agent: Schema.String, job: Schema.String }),
        Result: HeldDelegation,
        execute: ({ agent, job }) =>
          sql`SELECT signature, expiry FROM delivery_delegations WHERE agent = ${agent} AND job = ${job}`,
      })
      return Delegations.of({
        store: (operator, agent, job, { signature, expiry }, now) =>
          stored(sql`
            INSERT INTO delivery_delegations (agent, job, operator, signature, expiry, stored_at)
            VALUES (${agent}, ${job}, ${operator}, ${signature}, ${expiry}, ${now})
            ON CONFLICT (agent, job) DO UPDATE SET
              operator = excluded.operator, signature = excluded.signature, expiry = excluded.expiry,
              stored_at = excluded.stored_at`).pipe(Effect.asVoid),
        find: (agent, job) => stored(held({ agent, job })),
        remove: (agent, job) =>
          Effect.map(
            stored(sql`DELETE FROM delivery_delegations WHERE agent = ${agent} AND job = ${job} RETURNING job`),
            (rows) => rows.length > 0,
          ),
      })
    }),
  )
}
