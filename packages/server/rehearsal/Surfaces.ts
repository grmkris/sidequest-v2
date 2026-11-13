import type { TypedData } from '@sidequest/protocol'
import { Data, Effect, Predicate, Schedule, Schema } from 'effect'
import { McpClient, McpProtocol } from 'effect/ai'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import { isAddress } from 'viem'
import type { PrivateKeyAccount } from 'viem/accounts'

// The public surfaces only: the HTTP API's answers, a wallet's signature of the typed data it serves, and an MCP
// client holding an access token. Nothing here reaches a Worker's database directly.

/** What the API answered. */
export interface Reply {
  readonly status: number
  readonly body: unknown
}

/** A refused request, with what the API said. */
export class Refused extends Data.TaggedError('Refused')<{ readonly message: string }> {}

/** An MCP call that failed below the tool: in the transport, the HTTP exchange or the protocol. */
export class McpFailed extends Data.TaggedError('McpFailed')<{ readonly message: string }> {}

/**
 * What an MCP client failure carries, down to the wire: each error's name and message, an HTTP status and a code where
 * one has them, then its cause. "MCP HTTP request failed" alone hides whether the server answered at all.
 */
const detailOf = (failure: unknown, depth = 0): string => {
  if (!Predicate.isObject(failure) || depth > 8) return String(failure)
  const name = Predicate.hasProperty(failure, 'name') ? String(failure.name) : 'Error'
  const message = Predicate.hasProperty(failure, 'message') ? String(failure.message) : ''
  const status = Predicate.hasProperty(failure, 'status') ? ` (HTTP ${String(failure.status)})` : ''
  const code =
    Predicate.hasProperty(failure, 'code') && (Predicate.isString(failure.code) || Predicate.isNumber(failure.code))
      ? ` [${failure.code}]`
      : ''
  const cause = Predicate.hasProperty(failure, 'cause') ? failure.cause : undefined
  return `${name}: ${message}${status}${code}${cause === undefined ? '' : ` <- ${detailOf(cause, depth + 1)}`}`
}

/** The body of a successful reply, as `schema` reads it; otherwise the reply, refused. */
export const bodyOf = <A>(schema: Schema.Decoder<A>, reply: Reply, what: string): A => {
  if (reply.status < 200 || reply.status > 299)
    throw new Refused({ message: `${what}: ${reply.status} ${JSON.stringify(reply.body)}` })
  return Schema.decodeUnknownSync(schema)(reply.body)
}

/** Sign typed data as the protocol carries it, every integer a decimal string, with `wallet`. */
export const signTyped = (wallet: PrivateKeyAccount, typed: TypedData) => {
  const fields = [...(typed.types[typed.primaryType] ?? [])]
  const message = Object.fromEntries(
    fields.map(({ name, type }) => {
      const value = typed.message[name] ?? ''
      return [name, type.startsWith('uint') ? BigInt(value) : value]
    }),
  )
  const { verifyingContract } = typed.domain
  if (!isAddress(verifyingContract)) throw new Error('The typed data names no contract')
  return wallet.signTypedData({
    domain: { ...typed.domain, verifyingContract },
    types: { [typed.primaryType]: fields },
    primaryType: typed.primaryType,
    message,
  })
}

/**
 * Effect's MCP client, connected as the agent holding `token`, and the tool `name` it lists. Connecting and listing
 * change nothing, so a transport failure there is retried.
 */
const connect = (url: string, token: string, name: string) =>
  Effect.gen(function* () {
    const authorization = `Bearer ${token}`
    const transport = McpClient.http({
      url: `${url}/mcp`,
      protocol: McpProtocol.v2026_07_28,
      headers: { authorization },
    })
    const client = yield* Effect.provideServiceEffect(
      McpClient.make({ name: 'gate-rehearsal', version: '1' }),
      McpClient.Transport,
      transport,
    )
    const tool = (yield* client.listTools()).find((listed) => listed.name === name)
    if (tool === undefined) return yield* Effect.die(new Error(`The MCP server offers no ${name}`))
    return { client, tool }
  }).pipe(Effect.retry({ times: 2, schedule: Schedule.spaced('200 millis') }))

/**
 * One tool call. A read-only tool (its `readOnlyHint`) is retried after a transport failure, which once in a while
 * meets a connection the local runtime closed; a command is not, since it may have arrived.
 */
const callTool = (url: string, token: string, name: string, args: Record<string, unknown>) =>
  Effect.gen(function* () {
    const { client, tool } = yield* connect(url, token, name)
    const call = client.callTool({ tool, arguments: args })
    const reading = tool.annotations?.readOnlyHint === true
    const result = yield* reading
      ? call.pipe(Effect.retry({ times: 2, schedule: Schedule.spaced('200 millis') }))
      : call
    if (result.isError === true)
      return yield* Effect.die(new Refused({ message: `${name}: ${JSON.stringify(result.content)}` }))
    return result.structuredContent
  }).pipe(
    Effect.mapError((failure) => new McpFailed({ message: `${name}: ${detailOf(failure)}` })),
    Effect.scoped,
    Effect.provide(FetchHttpClient.layer),
  )

/** The MCP tools at `url`'s `/mcp`, called as the holder of the access token `token`. */
export const toolsAt = (
  url: string,
  token: string,
): { readonly call: (tool: string, args: Record<string, unknown>) => Promise<unknown> } => ({
  call: (tool, args) => Effect.runPromise(callTool(url, token, tool, args)),
})

/**
 * Ask until `done` holds, every `everyMillis` (100 ms) for at most `seconds`: views, projections and the chain follow
 * eventually. What asks a public RPC asks at a block's pace, not this one: the RPC's rate limit is shared with the stack.
 */
export const eventually = async <A>(
  read: () => Promise<A>,
  done: (value: A) => boolean,
  seconds = 60,
  everyMillis = 100,
) => {
  const until = Date.now() + seconds * 1000
  for (;;) {
    const value = await read()
    if (done(value)) return value
    if (Date.now() > until) throw new Error(`Still not there after ${seconds} s: ${JSON.stringify(value, bigints)}`)
    await new Promise((resolve) => setTimeout(resolve, everyMillis))
  }
}

const bigints = (_key: string, value: unknown) => (typeof value === 'bigint' ? String(value) : value)
