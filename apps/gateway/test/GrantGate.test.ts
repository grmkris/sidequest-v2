import { publicKeyOf, type PublicKey } from '@sidequest/nostr'
import { agentGrant, grantRevocation } from '@sidequest/nostr/vocabulary'
import type { GrantScope } from '@sidequest/protocol'
import { Effect, Layer, Result } from 'effect'
import { describe, expect, test } from 'vitest'
import { GrantGate } from '../src/Grants/GrantGate.ts'
import { GatewaySettings } from '../src/Settings.ts'
import { coreDouble } from './CoreDouble.ts'
import { freshKey, secret, signed } from './GatewayWorld.ts'

const now = () => Math.floor(Date.now() / 1000)

/** The gate over a fresh core double, with a cache window of `cacheSeconds`. */
const world = (cacheSeconds = 0) => {
  const core = coreDouble()
  const settings = Layer.succeed(GatewaySettings, {
    coreUrl: 'https://core.test',
    secret,
    grantCacheSeconds: cacheSeconds,
    release: 'test',
  })
  const layer = GrantGate.layer.pipe(Layer.provide(Layer.mergeAll(core.layer, settings)))
  const admit = (agent: PublicKey, operator: PublicKey, scope: GrantScope | null) =>
    Effect.runPromise(
      Effect.flatMap(GrantGate, (gate) => gate.admit(agent, operator, scope)).pipe(
        Effect.match({ onFailure: (error) => error, onSuccess: (admitted) => admitted }),
        Effect.provide(layer),
      ),
    )
  return { core, layer, admit }
}

const operatorKey = freshKey()
const operator = publicKeyOf(operatorKey)
const agent = publicKeyOf(freshKey())

const grant = (key = operatorKey, scopes: ReadonlyArray<GrantScope> = ['propose'], window = {}) =>
  signed(
    agentGrant,
    { agent, scopes: [...scopes], notBefore: now() - 60, expiresAt: now() + 3600, label: 'Scout', ...window },
    key,
  )

describe('the grant gate', () => {
  test('admits an agent with an active grant from its operator, naming that grant', async () => {
    const { core, admit } = world()
    const event = grant()
    core.events.push(event)
    expect(await admit(agent, operator, 'propose')).toMatchObject({ agent, operator, grant: { event: event.id } })
    expect(await admit(agent, operator, null)).toMatchObject({ grant: { event: event.id } })
  })

  test('refuses an agent no grant names', async () => {
    expect(await world().admit(agent, operator, null)).toMatchObject({ _tag: 'GrantRefused', reason: 'NoGrant' })
  })

  test('refuses a grant another key signed for the agent: only its operator’s count', async () => {
    const { core, admit } = world()
    core.events.push(grant(freshKey()))
    expect(await admit(agent, operator, 'propose')).toMatchObject({ reason: 'NoGrant' })
  })

  test('refuses an expired grant and one not yet begun', async () => {
    const expired = world()
    expired.core.events.push(grant(operatorKey, ['propose'], { notBefore: now() - 7200, expiresAt: now() - 60 }))
    expect(await expired.admit(agent, operator, null)).toMatchObject({ reason: 'GrantExpired' })
    const early = world()
    early.core.events.push(grant(operatorKey, ['propose'], { notBefore: now() + 600, expiresAt: now() + 7200 }))
    expect(await early.admit(agent, operator, null)).toMatchObject({ reason: 'GrantNotYet' })
  })

  test('refuses a revoked grant, saying it was revoked', async () => {
    const { core, admit } = world()
    const event = grant()
    core.events.push(event, signed(grantRevocation, { grant: event.id }, operatorKey))
    expect(await admit(agent, operator, 'propose')).toMatchObject({ reason: 'GrantRevoked' })
  })

  test('refuses a tool whose scope no active grant names', async () => {
    const { core, admit } = world()
    core.events.push(grant(operatorKey, ['discuss']))
    expect(await admit(agent, operator, 'accept')).toMatchObject({ reason: 'ScopeMissing', scope: 'accept' })
  })

  test('keeps a read for its window, then sees the revocation', async () => {
    const cached = world(30)
    const event = grant()
    cached.core.events.push(event)
    const gate = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          return yield* GrantGate
        }),
        cached.layer,
      ),
    )
    const admitted = (scope: GrantScope) => Effect.runPromise(Effect.result(gate.admit(agent, operator, scope)))
    expect(Result.isSuccess(await admitted('propose'))).toBe(true)
    cached.core.events.push(signed(grantRevocation, { grant: event.id }, operatorKey))
    // Within the window the gate still trusts its read; with no window it reads the core again.
    expect(Result.isSuccess(await admitted('propose'))).toBe(true)
    const uncached = world(0)
    uncached.core.events.push(...cached.core.events)
    expect(await uncached.admit(agent, operator, 'propose')).toMatchObject({ reason: 'GrantRevoked' })
  })
})
