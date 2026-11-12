import { Schema } from 'effect'
import { RpcMiddleware } from 'effect/rpc'
import { CurrentActor } from './CurrentActor.context.ts'

/** The request carries no session or agent token the server accepts. */
export class Unauthorized extends Schema.TaggedError<Unauthorized>()('Unauthorized', {}) {}

/** Authenticates a request and provides who sent it as the {@link CurrentActor}; each `decide` authorizes. */
export class Session extends RpcMiddleware.Service<Session, { provides: CurrentActor }>()('Sidequest/Session', {
  error: Unauthorized,
}) {}
