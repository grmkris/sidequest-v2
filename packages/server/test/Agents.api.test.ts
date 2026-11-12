import { Agent, AgentId, Page } from '@sidequest/protocol'
import { describe, expect, test } from 'vitest'
import { ada, ben, bodyOf, createdId, eventually, inSeconds, type Person, type Reply, withApi } from './HttpWorld.ts'

// A person's agents over HTTP: registered under a server-minted id, granted, revoked and listed from the `agents`
// projection, only ever by their operator.

const register = async (person: Person, name: string) => createdId(AgentId, await person.post('/api/agents', { name }))
const grant = { scopes: ['discuss', 'propose'], expiresAt: inSeconds(3600) }
const listed = (person: Person, query = '') => person.get(`/api/agents${query}`)
const pageOf = (reply: Reply) => bodyOf(Page(Agent), reply)

describe('the agents API', () => {
  test('registers an agent under the signed-in person, grants and revokes it, and lists it with its grant', () =>
    withApi(async ({ signIn }) => {
      const operator = await signIn(ada)
      const id = await register(operator, 'Scout')
      expect((await operator.put(`/api/agents/${id}/grant`, grant)).status).toBe(204)
      const granted = await eventually(
        () => listed(operator),
        (reply) => pageOf(reply).items[0]?.grant !== undefined,
      )
      expect(granted).toEqual({
        status: 200,
        body: { items: [{ id, operator: operator.account, name: 'Scout', grant, revoked: false }], next: null },
      })
      expect((await operator.post(`/api/agents/${id}/revoke`)).status).toBe(204)
      const revoked = await eventually(
        () => listed(operator),
        (reply) => pageOf(reply).items[0]?.revoked === true,
      )
      expect(pageOf(revoked).items).toEqual([{ id, operator: operator.account, name: 'Scout', grant, revoked: true }])
    }))

  test('refuses a stranger, an agent never registered, a revoked agent, a past expiry, and no session', () =>
    withApi(async ({ signIn, anonymous }) => {
      const operator = await signIn(ada)
      const stranger = await signIn(ben)
      const id = await register(operator, 'Scout')
      expect(await stranger.put(`/api/agents/${id}/grant`, grant)).toMatchObject({
        status: 403,
        body: {
          _tag: 'Forbidden',
          reason: 'NotPermitted',
          evidence: { account: stranger.account, required: 'operator' },
        },
      })
      expect(await operator.put('/api/agents/agent_01JCXZ4Q6N8M2V7T3R5W9Y0B1Z/grant', grant)).toMatchObject({
        status: 404,
        body: { _tag: 'NotFound', reason: 'NotRegistered' },
      })
      expect(await operator.put(`/api/agents/${id}/grant`, { ...grant, expiresAt: inSeconds(-60) })).toMatchObject({
        status: 422,
        body: { _tag: 'Unprocessable', reason: 'ExpiryNotInFuture' },
      })
      await operator.post(`/api/agents/${id}/revoke`)
      expect(await operator.put(`/api/agents/${id}/grant`, grant)).toMatchObject({
        status: 403,
        body: { reason: 'AgentRevoked', evidence: { agent: id } },
      })
      expect(await anonymous.post('/api/agents', { name: 'Nobody’s' })).toEqual({
        status: 401,
        body: { _tag: 'NotSignedIn' },
      })
      expect((await anonymous.get('/api/agents')).status).toBe(401)
    }))

  test('lists only the person’s own agents, a bounded page at a time, with an opaque cursor', () =>
    withApi(async ({ signIn }) => {
      const operator = await signIn(ada)
      const other = await signIn(ben)
      const ids = [await register(operator, 'One'), await register(operator, 'Two'), await register(operator, 'Three')]
      await register(other, 'Ben’s')
      await eventually(
        () => listed(operator),
        (reply) => pageOf(reply).items.length === 3,
      )
      const first = pageOf(await listed(operator, '?limit=2'))
      const second = pageOf(await listed(operator, `?limit=2&cursor=${first.next ?? ''}`))
      expect([...first.items, ...second.items].map(({ id }) => id)).toEqual(ids.toSorted())
      expect(first.items).toHaveLength(2)
      expect(second.next).toBeNull()
      expect(await listed(operator, '?cursor=bm90LWEtY3Vyc29y')).toMatchObject({
        status: 400,
        body: { _tag: 'BadCursor' },
      })
      for (const limit of ['0', '51', 'many']) expect((await listed(operator, `?limit=${limit}`)).status).toBe(400)
    }))
})
