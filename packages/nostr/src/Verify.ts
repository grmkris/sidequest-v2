import { Result, Schema } from 'effect'
import { NostrEvent } from './Event.ts'
import { eventIdOf } from './EventHash.ts'
import { bytesOf } from './Hex.ts'
import { schnorrVerify } from './Schnorr.ts'

/** Why an event is not a valid NIP-01 event: not its shape, an id that is not its hash, or a signature that fails. */
export class InvalidEvent extends Schema.TaggedError<InvalidEvent>()('InvalidEvent', {
  reason: Schema.Literals(['malformed', 'idMismatch', 'badSignature']),
}) {}

const decodeEvent = Schema.decodeUnknownResult(NostrEvent)

/**
 * Decodes an event, recomputes its id from its fields and checks the author's BIP-340 signature of that id. The
 * carried id is never trusted: it must equal the recomputed one. Total: any input gives a result.
 */
export const verifyEvent = (input: unknown): Result.Result<NostrEvent, InvalidEvent> =>
  Result.flatMap(
    Result.mapError(decodeEvent(input), () => new InvalidEvent({ reason: 'malformed' })),
    (event) => {
      const id = eventIdOf(event)
      if (id !== event.id) return Result.fail(new InvalidEvent({ reason: 'idMismatch' }))
      return schnorrVerify(bytesOf(event.sig), bytesOf(id), bytesOf(event.pubkey))
        ? Result.succeed(event)
        : Result.fail(new InvalidEvent({ reason: 'badSignature' }))
    },
  )
