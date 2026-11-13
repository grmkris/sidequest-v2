import { PublicKey } from '@sidequest/nostr'
import { Result, Schema } from 'effect'
import { describe, expect, test } from 'vitest'
import { openKey } from '../src/Keys/KeyEnvelope.ts'
import { freshKey, nip98, operatorOf, origin, secret, withGateway } from './GatewayWorld.ts'

const Row = Schema.Struct({ version: Schema.Number, dataKeySealed: Schema.String, keySealed: Schema.String })

describe('the operator API', () => {
  test('makes an agent for the key that signed the request, lists it, and never answers its key', () =>
    withGateway(async (gateway) => {
      const operator = freshKey()
      const created = await gateway.asOperator(operator, 'POST', '/api/agents', { label: 'Scout' })
      expect(created.status).toBe(201)
      expect(created.body).toMatchObject({ operator: operatorOf(operator), label: 'Scout' })
      const agent = Schema.decodeUnknownSync(Schema.Struct({ agent: Schema.String }))(created.body).agent
      const [row] = gateway.sqlite
        .prepare('SELECT version, data_key_sealed AS dataKeySealed, key_sealed AS keySealed FROM agents')
        .all()
      const sealed = Schema.decodeUnknownSync(Row)(row)
      // The key exists only sealed: it opens with the gateway's secret, and no answer or column holds it in the clear.
      const key = Result.getOrUndefined(openKey(secret, Schema.decodeSync(PublicKey)(agent), sealed))
      expect(key).toMatch(/^[0-9a-f]{64}$/u)
      expect(JSON.stringify(created.body)).not.toContain(key)
      expect(JSON.stringify(gateway.sqlite.prepare('SELECT * FROM agents').all())).not.toContain(key)
      const listed = await gateway.asOperator(operator, 'GET', '/api/agents')
      expect(listed.body).toEqual({ items: [expect.objectContaining({ agent, label: 'Scout' })] })
      expect(JSON.stringify(listed.body)).not.toContain(key)
      expect((await gateway.asOperator(freshKey(), 'GET', '/api/agents')).body).toEqual({ items: [] })
    }))

  test('deletes an agent and its key for its operator only', () =>
    withGateway(async (gateway) => {
      const operator = freshKey()
      const agent = await gateway.createAgent(operator)
      expect((await gateway.asOperator(freshKey(), 'DELETE', `/api/agents/${agent}`)).status).toBe(404)
      expect((await gateway.asOperator(operator, 'DELETE', `/api/agents/${agent}`)).status).toBe(204)
      expect(gateway.sqlite.prepare('SELECT COUNT(*) AS n FROM agents').get()).toEqual({ n: 0 })
    }))

  test('refuses a request without an authorization, or one signed for another URL or body', () =>
    withGateway(async (gateway) => {
      const operator = freshKey()
      const bare = await gateway.fetch('/api/agents', { method: 'GET' })
      expect(bare.status).toBe(401)
      const elsewhere = await gateway.fetch('/api/agents', {
        method: 'GET',
        headers: { authorization: nip98(operator, `${origin}/api/other`, 'GET') },
      })
      expect(await elsewhere.json()).toEqual({ error: 'unauthorized', reason: 'urlMismatch' })
      const body = JSON.stringify({ label: 'Scout' })
      const swapped = await gateway.fetch('/api/agents', {
        method: 'POST',
        headers: { authorization: nip98(operator, `${origin}/api/agents`, 'POST', '{"label":"Other"}') },
        body,
      })
      expect(await swapped.json()).toEqual({ error: 'unauthorized', reason: 'payloadMismatch' })
    }))

  test('refuses an authorization used before for a request that changes something', () =>
    withGateway(async (gateway) => {
      const operator = freshKey()
      const body = JSON.stringify({ label: 'Scout' })
      const headers = { authorization: nip98(operator, `${origin}/api/agents`, 'POST', body) }
      expect((await gateway.fetch('/api/agents', { method: 'POST', headers, body })).status).toBe(201)
      const replayed = await gateway.fetch('/api/agents', { method: 'POST', headers, body })
      expect(await replayed.json()).toEqual({ error: 'unauthorized', reason: 'replayed' })
    }))

  test('answers a browser’s preflight from any origin', () =>
    withGateway(async (gateway) => {
      const preflight = await gateway.fetch('/api/agents', { method: 'OPTIONS' })
      expect(preflight.status).toBe(204)
      expect(preflight.headers.get('access-control-allow-headers')).toContain('authorization')
    }))
})
