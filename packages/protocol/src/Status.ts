import { Schema } from 'effect'

export const ProtocolVersion = Schema.Literal('0.2-phase1')
export const Status = Schema.Struct({
  service: Schema.Literal('sidequest-v2'),
  status: Schema.Literal('ok'),
  protocolVersion: ProtocolVersion,
  release: Schema.String,
})
export type Status = typeof Status.Type
