import { Effect, Option } from 'effect'

// The website's way to the agent gateway's operator API. The gateway is another origin and the website's CSP allows
// only its own (`connect-src 'self'`), so the edge forwards `/gateway/api/agents…` to the stage's gateway, narrowly:
// only the operator API's paths and methods, only the request's NIP-98 `authorization` and its `content-type` (never a
// cookie or any other header), a body of at most 16 KiB, and back only the status, the body and its content type.
// The operator API reads nothing ambient (each request carries its own NIP-98 proof), so the proxy adds no authority:
// the page signs for the URL it calls here, which the gateway accepts as naming itself (see its `Nip98.ts`).

/** Where the website reaches the gateway on its own origin. */
const gatewayProxyPrefix = '/gateway'

/** Whether the edge proxies `path` to the gateway. */
export const isGatewayPath = (path: string): boolean =>
  path === gatewayProxyPrefix || path.startsWith(`${gatewayProxyPrefix}/`)

const key = '[0-9a-f]{64}'
/** The operator API's paths: the agents, one agent, its pause, its delegations and one job's delegation. */
const operatorPath = new RegExp(`^/api/agents(?:/${key}(?:/pause|/delegations(?:/${key})?)?)?$`, 'u')
const methods = ['GET', 'POST', 'DELETE'] as const
/** The largest body forwarded: the gateway's own limit for an operator request. */
export const maxProxiedBody = 16 * 1024
/** The request headers forwarded, and nothing else. */
const forwardedHeaders = ['authorization', 'content-type'] as const

/**
 * The stage's gateway from `SIDEQUEST_GATEWAY_URL`: an `https` origin (`http` for a local test stage), no path. Unset or
 * malformed, none: the edge then answers every `/gateway` request with 404 and the agents page says agents are not
 * available on this stage.
 */
export const gatewayOrigin = (setting: unknown): Option.Option<string> =>
  typeof setting === 'string' && /^https?:\/\/[^\s/?#]+$/u.test(setting.trim())
    ? Option.some(setting.trim())
    : Option.none()

const answer = (status: number, body: Record<string, string>, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } })

const isMethod = (method: string): method is (typeof methods)[number] => methods.some((allowed) => allowed === method)

/** The request's body, when it has one within {@link maxProxiedBody}; `undefined` for a GET or DELETE. */
const bodyOf = (request: Request) =>
  request.method !== 'POST'
    ? Effect.succeed(Option.some<ArrayBuffer | undefined>(undefined))
    : Number(request.headers.get('content-length') ?? '0') > maxProxiedBody
      ? Effect.succeed(Option.none<ArrayBuffer | undefined>())
      : Effect.map(
          Effect.tryPromise(() => request.arrayBuffer()),
          (body): Option.Option<ArrayBuffer | undefined> =>
            body.byteLength > maxProxiedBody ? Option.none() : Option.some(body),
        )

/** The request's headers the gateway gets: its NIP-98 authorization and its content type, nothing else. */
const forwardedHeadersOf = (request: Request): Headers => {
  const headers = new Headers()
  forwardedHeaders.forEach((name) => {
    const value = request.headers.get(name)
    if (value !== null) headers.set(name, value)
  })
  return headers
}

/** The gateway's answer as the page gets it: its status, its body and its content type. */
const answeredBy = (response: Response): Response => {
  const contentType = response.headers.get('content-type')
  return new Response(response.body, {
    status: response.status,
    headers: { 'cache-control': 'no-store', ...(contentType === null ? {} : { 'content-type': contentType }) },
  })
}

/**
 * Forwards one website request under `/gateway` to the gateway at `target` with `fetcher`, by the rules above. Answers
 * 404 when no gateway is configured or the path is not the operator API's, 405 for another method, 413 for a larger
 * body and 502 when the gateway does not answer.
 */
export const proxyToGateway = (
  request: Request,
  target: Option.Option<string>,
  fetcher: (request: Request) => Promise<Response>,
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    if (Option.isNone(target)) return answer(404, { error: 'gateway_not_configured' })
    const url = new URL(request.url)
    const path = url.pathname.slice(gatewayProxyPrefix.length)
    if (!operatorPath.test(path)) return answer(404, { error: 'not_found' })
    if (!isMethod(request.method)) return answer(405, { error: 'method_not_allowed' }, { allow: methods.join(', ') })
    const body = yield* bodyOf(request)
    if (Option.isNone(body)) return answer(413, { error: 'too_large' })
    const forwarded = new Request(`${target.value}${path}${url.search}`, {
      method: request.method,
      headers: forwardedHeadersOf(request),
      redirect: 'manual',
      ...(body.value === undefined ? {} : { body: body.value }),
    })
    return answeredBy(yield* Effect.tryPromise(() => fetcher(forwarded)))
  }).pipe(Effect.orElseSucceed(() => answer(502, { error: 'gateway_unreachable' })))
