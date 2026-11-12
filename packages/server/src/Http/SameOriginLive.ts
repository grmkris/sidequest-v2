import { CrossSiteRequest, SameOrigin } from '@sidequest/protocol'
import { Effect, Layer } from 'effect'
import type * as Headers from 'effect/http/Headers'
import { HttpServerRequest } from 'effect/http/HttpServerRequest'

/** Methods that change nothing, which any site may send. */
const safeMethods: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS'])

/** A JSON body, which a page on another origin can send only after a CORS preflight that this server never answers. */
const sendsJson = (headers: Headers.Headers) => /^application\/json\s*(?:;|$)/i.test(headers['content-type'] ?? '')

/**
 * Whether a request comes from this site, or from no browser at all, and so may change state. In order:
 *
 * 1. A safe method (GET, HEAD, OPTIONS) changes nothing: it passes, from anywhere.
 * 2. A browser sends `Origin` on every cross-origin request and every other POST, PUT, PATCH and DELETE; a page cannot
 *    set it. When it is there it must be this request's own origin (scheme, host and port of the URL the edge forwards
 *    unchanged). `Origin: null` (a sandboxed frame, a redirect, a `file:` page) is never this origin.
 * 3. A request without `Origin` that carries `Sec-Fetch-Site` came from a browser that hid its origin; it passes only
 *    when the browser vouches it is `same-origin`. Pages cannot set `Sec-` headers.
 * 4. A request with neither is from a client that is not a browser (an agent, a script, the tests), or from an old
 *    browser that omits `Origin`. It passes only with a JSON body: a form, a beacon or a `no-cors` fetch cannot send
 *    one, and a cross-origin `fetch` that does is preflighted, which fails here, so no other site can make a browser
 *    send it. A client that is not a browser has no one's cookie but its own to send, so it can forge nothing.
 *
 * The session cookie's `SameSite=Lax` is not the defence: a sibling subdomain is the same site, and not every browser
 * enforces it.
 */
export const fromThisSite = (request: HttpServerRequest) => {
  if (safeMethods.has(request.method)) return true
  const origin = request.headers.origin
  if (origin !== undefined) return origin === new URL(request.originalUrl).origin
  const fetchSite = request.headers['sec-fetch-site']
  if (fetchSite !== undefined) return fetchSite === 'same-origin'
  return sendsJson(request.headers)
}

/** {@link SameOrigin} on every endpoint: refuses with `CrossSiteRequest` what {@link fromThisSite} does not pass. */
export const SameOriginLive = Layer.succeed(SameOrigin, (httpEffect) =>
  Effect.flatMap(HttpServerRequest, (request) =>
    fromThisSite(request) ? Effect.void : Effect.fail(new CrossSiteRequest()),
  ).pipe(Effect.andThen(httpEffect)),
)
