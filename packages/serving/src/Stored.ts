import { Unavailable } from '@sidequest/protocol'
import { Effect, Option, type Schema } from 'effect'
import type { SqlError } from 'effect/sql/SqlError'

/** The span a D1 call ran in, which names the operation for the log. */
const currentOperation = Effect.map(
  Effect.option(Effect.currentSpan),
  Option.match({ onNone: () => 'unnamed', onSome: (span) => span.name }),
)

/**
 * A store call a request waits for. D1 not answering is logged with the operation and the driver's fixed failure
 * message (never the statement), and answers `Unavailable`, which carries nothing of the cause. A row that does not
 * decode is a broken invariant, a defect.
 */
export const stored = <A, R>(effect: Effect.Effect<A, SqlError | Schema.SchemaError, R>) =>
  effect.pipe(
    Effect.catchTag('SqlError', (error) =>
      Effect.flatMap(currentOperation, (operation) =>
        Effect.logWarning('Sidequest.Store unavailable').pipe(
          Effect.annotateLogs({ 'sidequest.store.operation': operation, 'sidequest.store.failure': error.message }),
          Effect.andThen(Effect.fail(new Unavailable())),
        ),
      ),
    ),
    Effect.catchTag('SchemaError', (error) => Effect.die(error)),
  )
