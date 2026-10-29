import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import { Effect } from 'effect'
import { describe, expect, test } from 'vitest'
import { makeAuthClient } from '../src/client.ts'

describe('Yielded Auth browser client', () => {
  test('uses the shared session contract and JSON transport envelope', async () => {
    const requests: Request[] = []
    const definition = makeAuthClient('https://sidequest.test')
    const response = new Response(JSON.stringify({ _tag: 'Success', value: null }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
    const fetch = async (request: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(request, init))
      return response.clone()
    }

    const session = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* definition
          return yield* client.auth.getSession()
        }).pipe(Effect.provide(definition.layerFetch), Effect.provideService(FetchHttpClient.Fetch, fetch)),
      ),
    )

    expect(session).toBeNull()
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe('https://sidequest.test/api/auth/getSession')
    expect(requests[0]?.method).toBe('POST')
    expect(requests[0]?.headers.get('x-effect-auth-csrf')).toBe('1')
    expect(requests[0]?.headers.get('content-type')).toBe('application/json')
    expect(await requests[0]?.text()).toBe('{}')
  })
})
