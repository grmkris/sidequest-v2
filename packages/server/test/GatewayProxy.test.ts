import { Effect, Option } from 'effect'
import { describe, expect, test } from 'vitest'
import { gatewayOrigin, maxProxiedBody, proxyToGateway } from '../src/GatewayProxy.ts'

const site = 'https://sidequest.test'
const gateway = Option.some('https://gateway.test')
const agent = 'ab'.repeat(32)
const job = 'cd'.repeat(32)

/** A gateway double that records what reached it and answers with a cookie and a header the page must not see. */
const recording = () => {
  const seen: Array<{ url: string; method: string; headers: Record<string, string>; body: string }> = []
  const fetcher = async (request: Request) => {
    seen.push({
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers),
      body: await request.text(),
    })
    return Response.json(
      { items: [] },
      { status: 201, headers: { 'set-cookie': 'tracking=1', 'x-gateway-internal': 'yes' } },
    )
  }
  return { seen, fetcher }
}

const proxy = (request: Request, fetcher: (request: Request) => Promise<Response>, target = gateway) =>
  Effect.runPromise(proxyToGateway(request, target, fetcher))

describe('the edge’s proxy to the agent gateway', () => {
  test('forwards the operator API’s request with its authorization and content type only, and its body and query', async () => {
    const { seen, fetcher } = recording()
    const body = JSON.stringify({ label: 'Scout' })
    const response = await proxy(
      new Request(`${site}/gateway/api/agents?x=1`, {
        method: 'POST',
        body,
        headers: {
          authorization: 'Nostr abc',
          'content-type': 'application/json',
          cookie: '__Host-sidequest-session=secret',
          'x-forwarded-for': '10.0.0.1',
          origin: site,
        },
      }),
      fetcher,
    )
    expect(seen).toEqual([
      {
        url: 'https://gateway.test/api/agents?x=1',
        method: 'POST',
        headers: { authorization: 'Nostr abc', 'content-type': 'application/json' },
        body,
      },
    ])
    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ items: [] })
    expect(Object.fromEntries(response.headers)).toEqual({
      'cache-control': 'no-store',
      'content-type': 'application/json',
    })
  })

  test('reaches every operator path: an agent, its pause, its delegations and one job’s', async () => {
    const { seen, fetcher } = recording()
    for (const path of [`/api/agents/${agent}`, `/api/agents/${agent}/pause`, `/api/agents/${agent}/delegations`]) {
      await proxy(new Request(`${site}/gateway${path}`, { method: 'GET' }), fetcher)
    }
    await proxy(new Request(`${site}/gateway/api/agents/${agent}/delegations/${job}`, { method: 'DELETE' }), fetcher)
    expect(seen.map(({ url, method }) => `${method} ${url}`)).toEqual([
      `GET https://gateway.test/api/agents/${agent}`,
      `GET https://gateway.test/api/agents/${agent}/pause`,
      `GET https://gateway.test/api/agents/${agent}/delegations`,
      `DELETE https://gateway.test/api/agents/${agent}/delegations/${job}`,
    ])
  })

  test('refuses what is not the operator API: other paths, other methods and large bodies, before the gateway', async () => {
    const { seen, fetcher } = recording()
    const statusOf = async (request: Request) => (await proxy(request, fetcher)).status
    expect(await statusOf(new Request(`${site}/gateway/mcp`, { method: 'POST', body: '{}' }))).toBe(404)
    expect(await statusOf(new Request(`${site}/gateway/oauth/token`, { method: 'POST', body: '{}' }))).toBe(404)
    expect(await statusOf(new Request(`${site}/gateway/api/agents/not-a-key`))).toBe(404)
    expect(await statusOf(new Request(`${site}/gateway/api/agents/../../status`))).toBe(404)
    expect(await statusOf(new Request(`${site}/gateway/api/agents`, { method: 'PUT', body: '{}' }))).toBe(405)
    const large = 'x'.repeat(maxProxiedBody + 1)
    expect(await statusOf(new Request(`${site}/gateway/api/agents`, { method: 'POST', body: large }))).toBe(413)
    expect(seen).toEqual([])
  })

  test('says no gateway is configured when the stage names none, and that it is unreachable when it does not answer', async () => {
    const { fetcher } = recording()
    const none = await proxy(new Request(`${site}/gateway/api/agents`), fetcher, Option.none())
    expect([none.status, await none.json()]).toEqual([404, { error: 'gateway_not_configured' }])
    const down = await proxy(new Request(`${site}/gateway/api/agents`), () => Promise.reject(new Error('down')))
    expect([down.status, await down.json()]).toEqual([502, { error: 'gateway_unreachable' }])
  })

  test('takes the stage setting only as an origin', () => {
    expect(gatewayOrigin('https://gateway.example.workers.dev')).toEqual(
      Option.some('https://gateway.example.workers.dev'),
    )
    expect(gatewayOrigin('http://127.0.0.1:8788')).toEqual(Option.some('http://127.0.0.1:8788'))
    expect(gatewayOrigin('')).toEqual(Option.none())
    expect(gatewayOrigin(undefined)).toEqual(Option.none())
    expect(gatewayOrigin('https://gateway.test/api')).toEqual(Option.none())
    expect(gatewayOrigin('javascript:alert(1)')).toEqual(Option.none())
  })
})
