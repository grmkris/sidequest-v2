import * as Domain from '@alchemy.run/domain'
import { AccountId, AgentId, Digest, IdempotencyKey, JobId, MessageSeq, MessageText, RoomId } from '@sidequest/protocol'
import { Schema } from 'effect'
import { scopedRejections } from '../Authority.ts'
import { NotPermitted } from '../NotPermitted.rejection.ts'
import { Session } from '../Session.middleware.ts'
import { Count, Members } from './Message.ts'
import { RoomNotOpen } from './RoomNotOpen.rejection.ts'

/** The author already used this key for a message (`seq`) that said something else. */
export class IdempotencyConflict extends Domain.Rejection('IdempotencyConflict', {
  key: IdempotencyKey,
  seq: MessageSeq,
}) {}

/** The agent's operator paused their agents in this room. */
export class AgentPaused extends Domain.Rejection('AgentPaused', { agent: AgentId, member: AccountId }) {}

/** Agents posted the last `consecutive` messages, the most allowed in a row; a person must post next. */
export class AgentTurnLimit extends Domain.Rejection('AgentTurnLimit', {
  consecutive: Count,
  limit: Count,
}) {}

/**
 * A member said something. The room assigned `seq`; `agentStreak` counts the messages in a row from agents, this one
 * included (0 when a person posted it).
 */
export class MessagePosted extends Domain.Event('MessagePosted', {
  job: JobId,
  members: Members,
  seq: MessageSeq,
  author: AccountId,
  agent: Schema.optionalKey(AgentId),
  text: MessageText,
  key: IdempotencyKey,
  digest: Digest,
  agentStreak: Count,
}) {}

/** A member, or their agent with `discuss`, posts text to the room. It never changes the job. */
export class PostMessage extends Domain.Command('PostMessage', {
  target: RoomId,
  middleware: [Session],
  input: { text: MessageText, key: IdempotencyKey },
  events: [MessagePosted],
  rejects: [...scopedRejections, RoomNotOpen, NotPermitted, IdempotencyConflict, AgentPaused, AgentTurnLimit],
}) {}
