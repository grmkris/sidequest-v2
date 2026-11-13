import { Schema } from 'effect'

// What a relay sends a client (NIP-01, NIP-42). A frame of any other shape is not one this client reads, and is
// skipped; an event inside `EVENT` stays unknown until the index validates it.

const EventFrame = Schema.Tuple([Schema.Literal('EVENT'), Schema.String, Schema.Unknown])
const OkFrame = Schema.Tuple([Schema.Literal('OK'), Schema.String, Schema.Boolean, Schema.String])
const EoseFrame = Schema.Tuple([Schema.Literal('EOSE'), Schema.String])
const ClosedFrame = Schema.Tuple([Schema.Literal('CLOSED'), Schema.String, Schema.String])
const NoticeFrame = Schema.Tuple([Schema.Literal('NOTICE'), Schema.String])
const AuthFrame = Schema.Tuple([Schema.Literal('AUTH'), Schema.String])

export const RelayFrame = Schema.Union([EventFrame, OkFrame, EoseFrame, ClosedFrame, NoticeFrame, AuthFrame])
export type RelayFrame = typeof RelayFrame.Type

/** A relay's text message as a frame, if it is one. */
export const decodeFrame = Schema.decodeUnknownOption(Schema.fromJsonString(RelayFrame))

/** A filter for `REQ` (NIP-01): the fields the index asks with. */
export interface Filter {
  readonly kinds?: ReadonlyArray<number>
  readonly authors?: ReadonlyArray<string>
  readonly since?: number
  readonly until?: number
  readonly limit?: number
}

/** A relay's answer to `EVENT`: whether it accepted the event, and its message (`duplicate: …`, `blocked: …`, …). */
export interface OkReply {
  readonly accepted: boolean
  readonly message: string
}
