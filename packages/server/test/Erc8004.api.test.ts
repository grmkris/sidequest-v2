import { publicKeyOf } from '@sidequest/nostr'
import {
  Erc8004Deployment,
  Erc8004RegistrationFile,
  labelsHeader,
  SidequestFeedbackFile,
  SidequestRegistrationFile,
} from '@sidequest/protocol'
import { Effect, Schema } from 'effect'
import { Moderation } from '../src/Index/Moderation.ts'
import { describe, expect, test } from 'vitest'
import { withApi } from './HttpWorld.ts'
import { alice, bob, carol, grant, linked, profile, walletOne } from './IndexWorld.ts'

// ERC-8004's reads on a stage without a settlement chain: no registries, so nothing to register on and no feedback,
// but a key's registration file is still its signed events' (ADR-0007, decision 4).

const at = Math.floor(Date.now() / 1000)

const post = (fetch: (path: string, init?: RequestInit) => Promise<Response>, event: unknown) =>
  fetch('/api/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(event) })

const read = async <A>(schema: Schema.Decoder<A>, response: Response) => {
  expect(response.status).toBe(200)
  return Schema.decodeUnknownSync(schema)(await response.json())
}

describe('ERC-8004 without a settlement chain', () => {
  test('names no registries, prepares no registration and serves an empty feedback file', () =>
    withApi(async ({ fetch }) => {
      expect(await read(Erc8004Deployment, await fetch('/api/erc8004'))).toEqual({
        chainId: null,
        identityRegistry: null,
        reputationRegistry: null,
      })
      expect((await fetch(`/api/erc8004/agents/${publicKeyOf(carol)}/registration-call`)).status).toBe(503)
      const file = await read(SidequestFeedbackFile, await fetch(`/api/erc8004/agents/${publicKeyOf(carol)}/feedback`))
      expect(file).toEqual({ subject: publicKeyOf(carol), registrations: [], count: 0, averageRating: null, items: [] })
      expect((await fetch(`/api/erc8004/agents/${publicKeyOf(carol)}/feedback/${'ab'.repeat(32)}`)).status).toBe(404)
    }))

  test('serves an agent’s registration file from its operator’s grant and wallets, and none for a stranger', () =>
    withApi(async ({ fetch }) => {
      const window = { createdAt: at - 10, notBefore: at - 10, expiresAt: at + 3600 }
      for (const event of [
        await linked(bob, walletOne, at - 20),
        grant(bob, carol, window, ['propose'], 'Translator'),
        profile(bob, at - 30, { name: 'Bob' }),
      ])
        expect((await post(fetch, event)).status).toBe(200)
      const response = await fetch(`/api/erc8004/agents/${publicKeyOf(carol)}/registration`)
      expect(response.headers.get('cache-control')).toBe('public, max-age=300')
      const file = await read(SidequestRegistrationFile, response)
      expect(Schema.is(Erc8004RegistrationFile)(file)).toBe(true)
      expect(file).toMatchObject({
        name: 'Translator',
        active: true,
        x402Support: false,
        registrations: [],
        supportedTrust: ['reputation'],
        sidequest: {
          pubkey: publicKeyOf(carol),
          operator: publicKeyOf(bob),
          feedback: `https://sidequest.test/api/erc8004/agents/${publicKeyOf(carol)}/feedback`,
        },
      })
      expect(file.services.map(({ name }) => name)).toEqual(['nostr', 'wallet'])
      expect(file.services[1]?.endpoint).toBe(`eip155:5042002:${walletOne.address.toLowerCase()}`)
      expect((await fetch(`/api/erc8004/agents/${publicKeyOf(alice)}/registration`)).status).toBe(404)
      expect(response.headers.get(labelsHeader)).toBeNull()
    }))

  test('labels a hidden key’s registration and feedback files, as the index labels its reads by id', () =>
    withApi(async ({ fetch, run }) => {
      const window = { createdAt: at - 10, notBefore: at - 10, expiresAt: at + 3600 }
      expect((await post(fetch, grant(bob, carol, window, ['propose'], 'Translator'))).status).toBe(200)
      const hide = {
        target: publicKeyOf(carol),
        kind: 'pubkey',
        reason: 'test',
        hiddenAt: at,
        hiddenBy: publicKeyOf(bob),
      } as const
      await run(Effect.flatMap(Moderation, (moderation) => moderation.hide(hide)))
      for (const file of ['registration', 'feedback']) {
        const response = await fetch(`/api/erc8004/agents/${publicKeyOf(carol)}/${file}`)
        expect(response.status).toBe(200)
        expect(response.headers.get(labelsHeader)).toBe('hidden')
      }
    }))
})
