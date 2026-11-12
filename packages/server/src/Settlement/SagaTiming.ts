import * as Cloudflare from '@alchemy.run/cloudflare'
import type { Timing } from '@sidequest/domain/Job/SettlementPlan'
import { SettlementTiming } from '@sidequest/domain/Job/SettlementTiming'
import { Effect, Layer, Option } from 'effect'

const positive = (millis: number | undefined): millis is number =>
  millis !== undefined && Number.isSafeInteger(millis) && millis > 0

/**
 * The settlement sagas' pace from `SIDEQUEST_SETTLEMENT_TIMING`: `poll,maxPoll,idle` in milliseconds (see
 * `SettlementTiming`). Unset, the sagas keep the domain's pace (15 s, up to an hour, idle an hour), which suits a live
 * chain. A rehearsal binds a fast one: on a local chain whose clock it moves forward by days, a saga asleep for an hour
 * of wall-clock time would miss every deadline the jump passed.
 */
export const sagaTimingFrom = (environment: Readonly<Record<string, unknown>>): Option.Option<Timing> => {
  const value = environment['SIDEQUEST_SETTLEMENT_TIMING']
  if (typeof value !== 'string') return Option.none()
  const [pollMillis, maxPollMillis, idleMillis, ...rest] = value.split(',').map(Number)
  return rest.length === 0 && positive(pollMillis) && positive(maxPollMillis) && positive(idleMillis)
    ? Option.some({ pollMillis, maxPollMillis, idleMillis })
    : Option.none()
}

/** The sagas' timing the Worker's configuration names, or the domain's default. */
export const SagaTimingLive = Layer.unwrap(
  Effect.map(Cloudflare.Workers.WorkerEnvironment, (environment) =>
    Option.match(sagaTimingFrom(environment), {
      onNone: () => Layer.empty,
      onSome: (timing) => Layer.succeed(SettlementTiming, timing),
    }),
  ),
)
