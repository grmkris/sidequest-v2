import { Effect, Layer, Redacted } from 'effect'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import { describe, expect, test } from 'vitest'
import { Core, CoreLive } from '../src/Core/Core.ts'
import { GatewaySecret } from '../src/Keys/KeyEnvelope.ts'
import { GatewaySettings } from '../src/Settings.ts'

// The core's refusals as the gateway reads them off the wire: its own HTTP client, decoding the core's answer with the
// core's API declaration, then reporting the refusal in the core's words.

const job = 'ab'.repeat(32)

/** The gateway's core client, at a core URL every request to which the test answers itself. */
const core = CoreLive.pipe(
  Layer.provide(
    Layer.succeed(GatewaySettings, {
      coreUrl: 'https://core.test',
      secret: Redacted.make(GatewaySecret.make('00'.repeat(32))),
      grantCacheSeconds: 30,
      release: 'test',
    }),
  ),
)

/** What reading a job's payment fails with when the core answers `status` and `body`. */
const paymentOf = (status: number, body: unknown) =>
  Effect.runPromise(
    Effect.flatMap(Core, (client) => client.payment(job)).pipe(
      Effect.flip,
      Effect.provide(core),
      Effect.provideService(FetchHttpClient.Fetch, async () => Response.json(body, { status })),
    ),
  )

describe('the core’s refusals at the gateway', () => {
  test('pass an escrow refusal through with its reason and detail, a grant’s refusal among them', async () => {
    const body = { _tag: 'EscrowRefused', reason: 'ProposalNotAuthorised', detail: 'The grant … : revoked.' }
    expect(await paymentOf(409, body)).toMatchObject({
      _tag: 'CoreRefused',
      refusal: 'EscrowRefused',
      reason: 'ProposalNotAuthorised',
      detail: 'The grant … : revoked.',
    })
  })

  test('read a reason the core does not declare as the core being unavailable, not as a refusal', async () => {
    expect(await paymentOf(409, { _tag: 'EscrowRefused', reason: 'NoSuchReason' })).toMatchObject({
      _tag: 'CoreUnavailable',
    })
  })
})
