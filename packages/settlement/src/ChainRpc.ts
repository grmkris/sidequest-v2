import { Context, Effect, Layer, Schema } from 'effect'
import { BaseError, createPublicClient, http, type PublicClient } from 'viem'

/**
 * The chain did not answer, or answered something that is not an answer (a transport or decoding failure). `reason`
 * is what the transport said, when it said something (an HTTP 429, a timeout), for the log of whoever reports it.
 */
export class ChainUnavailable extends Schema.TaggedError<ChainUnavailable>()('ChainUnavailable', {
  operation: Schema.String,
  reason: Schema.optional(Schema.String),
}) {}

/**
 * A read-only JSON-RPC client for the settlement chain. The reader and the relayer reach the chain only through it,
 * so tests give it a fake transport and production an RPC URL from configuration.
 */
export class ChainRpc extends Context.Service<ChainRpc, PublicClient>()('Sidequest/Settlement/ChainRpc') {
  static readonly layer = (url: string) =>
    Layer.sync(ChainRpc, () => createPublicClient({ transport: http(url, { retryCount: 2, timeout: 10_000 }) }))
}

/** What a failed call's cause says, briefly: viem's short message, or the error's own. */
const reasonOf = (cause: unknown) =>
  (cause instanceof BaseError ? cause.shortMessage : cause instanceof Error ? cause.message : String(cause)).slice(
    0,
    200,
  )

/** Runs one RPC call; any failure is the chain being unavailable for `operation`. */
export const rpcCall = <A>(operation: string, call: () => Promise<A>) =>
  Effect.tryPromise({ try: call, catch: (cause) => new ChainUnavailable({ operation, reason: reasonOf(cause) }) })
