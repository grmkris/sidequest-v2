import { Effect, Option, Predicate, Schema } from 'effect'
import { Base64 } from 'effect/encoding'
import * as HttpServerRequest from 'effect/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'

/**
 * The revision Effect's MCP server speaks: stateless, each request carrying its own protocol version and the client's
 * capabilities in `_meta`, so any Worker isolate can answer any request.
 */
export const statelessRevision = '2026-07-28'

/**
 * The older revisions clients still connect with (Claude, ChatGPT and the official SDK's 1.x line negotiate 2025-11-25
 * through `initialize`), newest first. Both allow a server to issue no `Mcp-Session-Id` (Streamable HTTP, "Session
 * Management": the server MAY assign one), and both have the client send `MCP-Protocol-Version` on every request after
 * `initialize`. So they are served without a session: `initialize` answers from what the server states anyway, and
 * every later request is translated to {@link statelessRevision} and served by the same server, toolkit and handlers.
 */
export const legacyRevisions: ReadonlyArray<string> = ['2025-11-25', '2025-06-18']

/** Every revision this endpoint serves, newest first: what discovery and a version refusal name as supported. */
export const servedRevisions: ReadonlyArray<string> = [statelessRevision, ...legacyRevisions]

/** What a 2025 client that sends no version header speaks, by the transport's rule ("SHOULD assume 2025-03-26"). */
const unversioned = '2025-03-26'

const versionKey = 'io.modelcontextprotocol/protocolVersion'
const capabilitiesKey = 'io.modelcontextprotocol/clientCapabilities'
const serverInfoKey = 'io.modelcontextprotocol/serverInfo'

const parseError = -32700
const invalidRequest = -32600
const methodNotFound = -32601
const invalidParams = -32602
const internalError = -32603
const headerMismatch = -32020
const unsupportedVersion = -32022

const RequestId = Schema.Union([Schema.String, Schema.Number])
type RequestId = typeof RequestId.Type
const Params = Schema.Record(Schema.String, Schema.Unknown)
type Params = typeof Params.Type

/** One JSON-RPC request or notification, as a client sends it. A batch is not one: no served revision has batches. */
const Incoming = Schema.Struct({
  jsonrpc: Schema.Literal('2.0'),
  id: Schema.optional(RequestId),
  method: Schema.String,
  params: Schema.optional(Params),
})
type Incoming = typeof Incoming.Type
const decodeIncoming = Schema.decodeUnknownOption(Schema.fromJsonString(Incoming))

const InitializeParams = Schema.Struct({
  protocolVersion: Schema.String,
  capabilities: Params,
  clientInfo: Schema.Struct({ name: Schema.String, version: Schema.String }),
})
const isInitializeParams = Schema.is(InitializeParams)

/** The one answer to a request: a result or an error, for the request's id. */
const Reply = Schema.Struct({
  jsonrpc: Schema.Literal('2.0'),
  id: Schema.NullOr(RequestId),
  result: Schema.optional(Params),
  error: Schema.optional(Params),
})
type Reply = typeof Reply.Type
const decodeReply = Schema.decodeUnknownOption(Schema.fromJsonString(Reply))

const Discovery = Schema.Struct({
  capabilities: Params,
  instructions: Schema.optional(Schema.String),
  _meta: Schema.Struct({ [serverInfoKey]: Params }),
})
const decodeDiscovery = Schema.decodeUnknownOption(Discovery)

const answer = (body: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: { 'cache-control': 'no-store' } })

const failure = (id: RequestId | undefined, code: number, message: string, status = 200, data?: unknown) =>
  answer(
    { jsonrpc: '2.0', id: id ?? null, error: data === undefined ? { code, message } : { code, message, data } },
    status,
  )

const success = (id: RequestId, result: unknown) => answer({ jsonrpc: '2.0', id, result })

const unsupported = (id: RequestId | undefined, requested: string) =>
  failure(id, unsupportedVersion, `Unsupported protocol version '${requested}'`, 400, {
    supported: servedRevisions,
    requested,
  })

/** A routing header's value: visible ASCII as it is, anything else Base64 between the revision's sentinels. */
const headerValue = (value: string) =>
  /^[\x20-\x7e]*$/u.test(value) && value.trim() === value && !(value.startsWith('=?base64?') && value.endsWith('?='))
    ? value
    : `=?base64?${Base64.encode(value)}?=`

/** The answer in a response from the stateless server, sent as JSON or as the last event of a stream. */
const replyIn = (text: string, contentType: string | null): Option.Option<Reply> => {
  if (contentType?.startsWith('text/event-stream') !== true) return decodeReply(text)
  const events = text
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => decodeReply(line.slice('data:'.length).trim()))
  return Option.firstSomeOf(events.toReversed())
}

/** A result as the older revisions shape it: without the stateless revision's result type, cache hints and server
 * info. A tool asking for more input mid-call cannot be carried without a session. */
const legacyResult = (result: Params): Option.Option<Params> => {
  const { resultType, ttlMs: _ttl, cacheScope: _scope, _meta, ...rest } = result
  if (resultType === 'input_required') return Option.none()
  const meta = Predicate.isReadonlyObject(_meta)
    ? Object.fromEntries(Object.entries(_meta).filter(([key]) => !key.startsWith('io.modelcontextprotocol/')))
    : {}
  return Option.some(Object.keys(meta).length === 0 ? rest : { ...rest, _meta: meta })
}

/** A request's headers for the request translated from it, whose body has its own length. */
const headersOf = (request: HttpServerRequest.HttpServerRequest) => {
  const headers = new Headers(Object.entries(request.headers))
  headers.delete('content-length')
  return headers
}

type Served<E, R> = Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>

/** The stateless server's answer to `message`, sent as the stateless revision sends it, with the original headers. */
const statelessCall = <E, R>(
  stateless: Served<E, R>,
  original: HttpServerRequest.HttpServerRequest,
  message: { readonly id: RequestId; readonly method: string; readonly params: Params },
) =>
  Effect.gen(function* () {
    const meta = Predicate.isReadonlyObject(message.params['_meta']) ? message.params['_meta'] : {}
    const params = { ...message.params, _meta: { ...meta, [versionKey]: statelessRevision, [capabilitiesKey]: {} } }
    const headers = headersOf(original)
    headers.set('mcp-protocol-version', statelessRevision)
    headers.set('mcp-method', message.method)
    if (Predicate.isString(message.params['name'])) headers.set('mcp-name', headerValue(message.params['name']))
    const body = JSON.stringify({ jsonrpc: '2.0', id: message.id, method: message.method, params })
    const translated = HttpServerRequest.fromWeb(new Request(original.originalUrl, { method: 'POST', headers, body }))
    return yield* readAnswer(Effect.provideService(stateless, HttpServerRequest.HttpServerRequest, translated))
  })

/** A response's status and its one JSON-RPC answer, if it carries one. */
const readAnswer = <E, R>(served: Served<E, R>) =>
  Effect.gen(function* () {
    const response = yield* served
    const context = yield* Effect.context()
    const web = HttpServerResponse.toWeb(response, { context })
    const text = yield* Effect.promise(() => web.text())
    return { response, status: web.status, reply: replyIn(text, web.headers.get('content-type')) }
  })

/**
 * `initialize` in an older revision: the version is negotiated (the one asked for if it is served, else the newest
 * served older revision, which the client may refuse), and the capabilities, server info and instructions are the
 * stateless server's own discovery. No `Mcp-Session-Id` is issued, so nothing is kept between requests.
 */
const initialize = <E, R>(stateless: Served<E, R>, request: HttpServerRequest.HttpServerRequest, message: Incoming) =>
  Effect.gen(function* () {
    const { id, params } = message
    if (id === undefined) return failure(undefined, invalidRequest, 'initialize is a request and needs an id', 400)
    if (!isInitializeParams(params)) return failure(id, invalidParams, 'Invalid initialize parameters')
    const requested = params.protocolVersion
    const protocolVersion = legacyRevisions.includes(requested) ? requested : (legacyRevisions[0] ?? requested)
    const { reply } = yield* statelessCall(stateless, request, { id, method: 'server/discover', params: {} })
    const discovered = Option.flatMap(reply, ({ result }) => decodeDiscovery(result))
    if (Option.isNone(discovered)) return failure(id, internalError, 'The server could not describe itself')
    const { capabilities, instructions, _meta } = discovered.value
    return success(id, {
      protocolVersion,
      capabilities,
      serverInfo: _meta[serverInfoKey],
      ...(instructions === undefined ? {} : { instructions }),
    })
  })

/** A request after `initialize` in an older revision: served by the stateless server, answered in the older shape. */
const legacyRequest = <E, R>(
  stateless: Served<E, R>,
  request: HttpServerRequest.HttpServerRequest,
  message: Incoming,
) =>
  Effect.gen(function* () {
    const { id, method, params = {} } = message
    // A notification (`notifications/initialized`, `notifications/cancelled`, ...) needs no answer and changes nothing.
    if (id === undefined) return HttpServerResponse.empty({ status: 202 })
    if (method === 'ping') return success(id, {})
    if (method !== 'tools/list' && method !== 'tools/call') return failure(id, methodNotFound, 'Method not found')
    const { response, status, reply } = yield* statelessCall(stateless, request, { id, method, params })
    if (Option.isNone(reply)) return response
    const { result, error } = reply.value
    if (result === undefined) return answer({ jsonrpc: '2.0', id, error }, status)
    return Option.match(legacyResult(result), {
      onNone: () => failure(id, internalError, 'The tool needs input this protocol revision cannot carry'),
      onSome: (shaped) => success(id, shaped),
    })
  })

/** A stateless request, served as it came; discovery names every served revision, so a client may pick an older one. */
const statelessRequest = <E, R>(
  stateless: Served<E, R>,
  request: HttpServerRequest.HttpServerRequest,
  text: string,
  message: Option.Option<Incoming>,
) =>
  Effect.gen(function* () {
    const forwarded = HttpServerRequest.fromWeb(
      new Request(request.originalUrl, { method: 'POST', headers: headersOf(request), body: text }),
    )
    const served = Effect.provideService(stateless, HttpServerRequest.HttpServerRequest, forwarded)
    if (Option.isNone(message) || message.value.method !== 'server/discover') return yield* served
    const { response, status, reply } = yield* readAnswer(served)
    if (Option.isNone(reply) || reply.value.result === undefined) return response
    return answer({ ...reply.value, result: { ...reply.value.result, supportedVersions: servedRevisions } }, status)
  })

/** Whether a message's own `_meta` claims a revision other than the header's. */
const claimsOtherRevision = (message: Incoming, version: string) => {
  const meta = message.params?.['_meta']
  return Predicate.isReadonlyObject(meta) && versionKey in meta && meta[versionKey] !== version
}

/**
 * Serves the older revisions in front of the stateless server, by the request's `MCP-Protocol-Version` header: the
 * stateless revision goes straight through; `initialize` (which only older revisions send) is answered here; a request
 * naming an older served revision is translated; anything else (no header, which the older transport reads as
 * 2025-03-26, or a revision not served) is refused with 400 and the served revisions, as every revision requires.
 */
export const servingRevisions = <E, R>(stateless: Served<E, R>) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    if (request.method !== 'POST') return yield* stateless
    const text = yield* Effect.option(request.text)
    if (Option.isNone(text)) return HttpServerResponse.empty({ status: 413 })
    const message = decodeIncoming(text.value)
    const version = request.headers['mcp-protocol-version']
    if (version === statelessRevision) return yield* statelessRequest(stateless, request, text.value, message)
    if (Option.isSome(message) && message.value.method === 'initialize')
      return yield* initialize(stateless, request, message.value)
    return yield* olderRevision(stateless, request, { text: text.value, message, version })
  })

/** A request after `initialize`, refused unless it names a served older revision its metadata does not contradict. */
const olderRevision = <E, R>(
  stateless: Served<E, R>,
  request: HttpServerRequest.HttpServerRequest,
  { text, message, version }: { text: string; message: Option.Option<Incoming>; version: string | undefined },
) => {
  const id = Option.getOrUndefined(Option.flatMapNullishOr(message, ({ id: requestId }) => requestId))
  if (version === undefined) return Effect.succeed(unsupported(id, unversioned))
  if (!legacyRevisions.includes(version)) return Effect.succeed(unsupported(id, version))
  if (Option.isNone(message))
    return Effect.succeed(
      text.trimStart().startsWith('[')
        ? failure(undefined, invalidRequest, 'Batches are not supported', 400)
        : failure(undefined, parseError, 'Parse error', 400),
    )
  if (claimsOtherRevision(message.value, version))
    return Effect.succeed(
      failure(id, headerMismatch, 'MCP-Protocol-Version header does not match request metadata', 400),
    )
  return legacyRequest(stateless, request, message.value)
}
