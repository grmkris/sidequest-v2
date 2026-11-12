import { Context, Effect, Layer, Schema } from 'effect'
import { createPublicClient, http, type PublicClient } from 'viem'

/** The chain did not answer, or answered something that is not an answer (a transport or decoding failure). */
export class ChainUnavailable extends Schema.TaggedError<ChainUnavailable>()('ChainUnavailable', {
  operation: Schema.String,
}) {}

/**
 * A read-only JSON-RPC client for the settlement chain. The reader and the relayer reach the chain only through it,
 * so tests give it a fake transport and production an RPC URL from configuration.
 */
export class ChainRpc extends Context.Service<ChainRpc, PublicClient>()('Sidequest/Settlement/ChainRpc') {
  static readonly layer = (url: string) =>
    Layer.sync(ChainRpc, () => createPublicClient({ transport: http(url, { retryCount: 2, timeout: 10_000 }) }))
}

/** Runs one RPC call; any failure is the chain being unavailable for `operation`. */
export const rpcCall = <A>(operation: string, call: () => Promise<A>) =>
  Effect.tryPromise({ try: call, catch: () => new ChainUnavailable({ operation }) })
