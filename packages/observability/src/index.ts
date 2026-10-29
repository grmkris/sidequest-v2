import { Effect, Schema } from 'effect'

export const TraceId = Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/))
export type TraceId = typeof TraceId.Type

export type ObservabilityBase = Readonly<{
  environment: string
  release: string
  component: string
}>

export const makeObservabilityBase = (input: ObservabilityBase): Effect.Effect<ObservabilityBase> =>
  Effect.succeed(input)

export const metadataFromHeaders = (
  base: ObservabilityBase,
  headers: Readonly<Record<string, string | undefined>>,
) => ({
  ...base,
  correlationId: headers['x-sidequest-correlation-id'] ?? 'none',
})

export const withObservability =
  (name: string, metadata: Readonly<Record<string, unknown>>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    effect.pipe(Effect.withSpan(name), Effect.annotateLogs(metadata))
