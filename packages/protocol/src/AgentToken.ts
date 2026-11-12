import { Schema } from 'effect'
import { AgentId, AgentTokenId } from './Id.ts'
import { UnixSeconds } from './UnixSeconds.ts'

const hour = 60 * 60
const day = 24 * hour

/** How long a token lasts when its operator does not say: 30 days. */
export const defaultTokenLifetimeSeconds = 30 * day

/** How long an agent's access token may last, in seconds: from an hour to 90 days. */
export const TokenLifetime = Schema.Int.check(Schema.isBetween({ minimum: hour, maximum: 90 * day }))

/**
 * An agent's access token, the secret it sends as `Authorization: Bearer <token>` on every MCP request: `sqa_` and 32
 * random bytes in hex. The server stores only its SHA-256, so it is shown once, when it is issued.
 */
export const AgentAccessToken = Schema.String.check(Schema.isPattern(/^sqa_[0-9a-f]{64}$/u))

/** What an operator sees of a token they issued: which agent it is for, when it was issued, ends and was revoked. */
export const AgentToken = Schema.Struct({
  id: AgentTokenId,
  agent: AgentId,
  issuedAt: UnixSeconds,
  expiresAt: UnixSeconds,
  revokedAt: Schema.NullOr(UnixSeconds),
})
export type AgentToken = typeof AgentToken.Type

/** A token as it is issued: its metadata and, this once, the secret itself. */
export const IssuedAgentToken = Schema.Struct({ ...AgentToken.fields, token: AgentAccessToken })
export type IssuedAgentToken = typeof IssuedAgentToken.Type
