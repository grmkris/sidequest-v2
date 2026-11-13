import { freshSecretKey, PublicKey, publicKeyOf, type SecretKey } from '@sidequest/nostr'
import { type Unavailable, type UnixSeconds, webCrypto } from '@sidequest/protocol'
import { stored } from '@sidequest/serving/Stored'
import { Context, Crypto, Effect, Layer, Option, Result, Schema } from 'effect'
import * as SqlClient from 'effect/sql/SqlClient'
import * as SqlSchema from 'effect/sql/SqlSchema'
import { GatewaySettings } from '../Settings.ts'
import { freshSealEntropy, KeyUnsealable, openKey, sealKey } from './KeyEnvelope.ts'

/** An agent as its operator sees it: its public key (what they grant), their label for it, and when it was made. */
export const AgentRecord = Schema.Struct({
  agent: PublicKey,
  operator: PublicKey,
  label: Schema.String,
  createdAt: Schema.Int,
})
export type AgentRecord = typeof AgentRecord.Type

/** The longest label an operator gives an agent. */
export const maxLabelLength = 120

/** The most agents one operator keeps at the gateway. */
export const maxAgentsPerOperator = 20

/** The operator already keeps {@link maxAgentsPerOperator} agents here. */
export class TooManyAgents extends Schema.TaggedError<TooManyAgents>()('TooManyAgents', {}) {}

const Sealed = Schema.Struct({ version: Schema.Int, dataKeySealed: Schema.String, keySealed: Schema.String })

const recordColumns = 'pubkey AS agent, operator, label, created_at AS createdAt'

/**
 * Agents' keys in the gateway's D1. A key is made here, sealed at once (`KeyEnvelope.ts`) and stored only sealed; it
 * is opened only inside {@link AgentKeys.withKey}, for the one signature a tool call needs, and never leaves the
 * Worker. Deleting an agent deletes its sealed key, so nothing can open it again, revokes its OAuth connections and
 * forgets its delivery delegations.
 */
export class AgentKeys extends Context.Service<
  AgentKeys,
  {
    readonly create: (
      operator: PublicKey,
      label: string,
      now: UnixSeconds,
    ) => Effect.Effect<AgentRecord, TooManyAgents | Unavailable>
    readonly list: (operator: PublicKey) => Effect.Effect<ReadonlyArray<AgentRecord>, Unavailable>
    readonly find: (agent: PublicKey) => Effect.Effect<Option.Option<AgentRecord>, Unavailable>
    /** Destroys the operator's agent and its key, and ends its connections; answers whether there was one. */
    readonly remove: (operator: PublicKey, agent: PublicKey, now: UnixSeconds) => Effect.Effect<boolean, Unavailable>
    /** Runs `use` with the agent's secret key, opened in memory for that run only. */
    readonly withKey: <A, E, R>(
      agent: PublicKey,
      use: (key: SecretKey) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | KeyUnsealable | Unavailable, R>
  }
>()('Sidequest/Gateway/AgentKeys') {
  /** On D1; needs the database's `SqlClient` and the gateway's settings (its secret). */
  static readonly layer = Layer.effect(
    AgentKeys,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const { secret } = yield* GatewaySettings
      const columns = sql.literal(recordColumns)
      const byOperator = SqlSchema.findAll({
        Request: Schema.String,
        Result: AgentRecord,
        execute: (operator) =>
          sql`SELECT ${columns} FROM agents WHERE operator = ${operator} ORDER BY created_at, pubkey`,
      })
      const byKey = SqlSchema.findOneOption({
        Request: Schema.String,
        Result: AgentRecord,
        execute: (agent) => sql`SELECT ${columns} FROM agents WHERE pubkey = ${agent}`,
      })
      const sealedOf = SqlSchema.findOneOption({
        Request: Schema.String,
        Result: Sealed,
        execute: (agent) => sql`
          SELECT version, data_key_sealed AS dataKeySealed, key_sealed AS keySealed FROM agents WHERE pubkey = ${agent}`,
      })
      return AgentKeys.of({
        create: Effect.fn('Sidequest.Gateway.AgentKeys.create')(function* (operator, label, now) {
          const key = yield* freshSecretKey.pipe(Effect.provideService(Crypto.Crypto, webCrypto))
          const agent = publicKeyOf(key)
          const entropy = yield* freshSealEntropy.pipe(Effect.provideService(Crypto.Crypto, webCrypto))
          const sealed = sealKey(secret, agent, key, entropy)
          // One statement: the count and the insert cannot interleave with another create for the same operator.
          const inserted = yield* stored(sql`
            INSERT INTO agents (pubkey, operator, label, version, data_key_sealed, key_sealed, created_at)
            SELECT ${agent}, ${operator}, ${label}, ${sealed.version}, ${sealed.dataKeySealed}, ${sealed.keySealed},
              ${now}
            WHERE (SELECT COUNT(*) FROM agents WHERE operator = ${operator}) < ${maxAgentsPerOperator}
            RETURNING pubkey`)
          if (inserted.length !== 1) return yield* new TooManyAgents()
          return { agent, operator, label, createdAt: now }
        }),
        list: (operator) => stored(byOperator(operator)),
        find: (agent) => stored(byKey(agent)),
        remove: Effect.fn('Sidequest.Gateway.AgentKeys.remove')(function* (operator, agent, now) {
          const deleted = yield* stored(
            sql`DELETE FROM agents WHERE pubkey = ${agent} AND operator = ${operator} RETURNING pubkey`,
          )
          if (deleted.length === 0) return false
          yield* stored(sql`DELETE FROM delivery_delegations WHERE agent = ${agent}`)
          yield* stored(
            sql`UPDATE oauth_connections SET revoked_at = ${now} WHERE agent = ${agent} AND revoked_at IS NULL`,
          )
          return true
        }),
        withKey: (agent, use) =>
          Effect.gen(function* () {
            const row = yield* stored(sealedOf(agent))
            if (Option.isNone(row)) return yield* new KeyUnsealable()
            const opened = openKey(secret, agent, row.value)
            if (Result.isFailure(opened)) return yield* opened.failure
            return yield* use(opened.success)
          }),
      })
    }),
  )
}
