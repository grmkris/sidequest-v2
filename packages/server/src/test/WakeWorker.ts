import * as Cloudflare from '@alchemy.run/cloudflare'
import * as Workflows from 'alchemy/Workflows'
import { Effect, Layer, Predicate, Schema } from 'effect'
import { HttpServerRequest } from 'effect/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import { Activity, DurableClock, Workflow } from 'effect/workflow'

// A Worker for the native test only: one workflow on the Durable Object engine that the model's sagas run on, which
// sleeps `sleeps` times for `millis` each, as a saga does between looks at the chain, and records each wake. Each
// wake-up is progress, so the run must take about `sleeps × millis`, not back off as if every wake were a retry.

export const sleeps = 6
export const millis = 200

const Wakes = Workflow.make('Wakes', {
  payload: { id: Schema.String },
  success: Schema.Number,
  idempotencyKey: ({ id }) => id,
})

const WakesLive = Workflows.layer(
  Wakes,
  Effect.fn(function* () {
    for (let round = 0; round < sleeps; round += 1) {
      yield* Activity.make({ name: `wake-${round}`, execute: Effect.void })
      yield* DurableClock.sleep({ name: `sleep-${round}`, duration: millis, inMemoryThreshold: 0 })
    }
    return sleeps
  }),
)

export class WakeWorker extends Cloudflare.Worker<WakeWorker, Cloudflare.WorkerShape>()('WakeWorker') {}

export default WakeWorker.make(
  { main: import.meta.url, compatibility: { date: '2026-10-19' } },
  Effect.gen(function* () {
    const wakes = yield* Workflows.RunWorkflow(Wakes)
    // `/start/<id>` starts a run; `/status/<id>` answers its status.
    const fetch = Effect.gen(function* () {
      const request = yield* HttpServerRequest
      const [, action = '', id = ''] = new URL(request.url, 'http://wake').pathname.split('/')
      if (action === 'start')
        return yield* HttpServerResponse.json({ executionId: (yield* wakes.start({ id })).executionId })
      if (action === 'status') {
        const status = yield* wakes.get(id).status
        return yield* HttpServerResponse.json(
          Predicate.isTagged(status, 'Completed') ? { completed: true, result: status.result } : { completed: false },
        )
      }
      return HttpServerResponse.empty({ status: 404 })
    }).pipe(Effect.orDie)
    return { fetch }
  }).pipe(Effect.provide(WakesLive.pipe(Layer.provideMerge(Cloudflare.Workflows.DurableObjectEngine)))),
)
