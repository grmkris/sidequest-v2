import { Effect, Logger } from 'effect'
import { apiPolicy, documentPolicy, withSecurityHeaders } from './EdgeSecurity.ts'
import { makeAdmissions } from './RelayPipe/PipeAdmission.ts'
import { pipeLimits } from './RelayPipe/PipePolicy.ts'
import { openRelayPipe } from './RelayPipe/RelayPipe.ts'

type FetchService = { readonly fetch: (request: Request) => Promise<Response> }
/** The edge's bindings. `SIDEQUEST_RELAY_POLICY` is set to `local` by the native tests alone; unset, the relay pipe
 * dials only public relays (see `Index/RelayUrls.ts`). */
export type EdgeEnvironment = {
  readonly API: FetchService
  readonly WEBSITE: FetchService
  readonly SIDEQUEST_RELAY_POLICY?: string
}

const apiNamespaces = ['/api', '/rpc', '/mcp', '/oauth', '/.well-known', '/out', '/cdn'] as const
export const isApiPath = (path: string): boolean =>
  apiNamespaces.some((namespace) => path === namespace || path.startsWith(`${namespace}/`))

/** The relay pipe's path: a WebSocket to a Nostr relay, for pages of this site (`RelayPipe/RelayPipe.ts`). */
const relayPipePath = '/relay'

// One isolate's count of pipes per client address; see `RelayPipe/PipeAdmission.ts` for what it does not bound.
const admissions = makeAdmissions()

const relayPipe = (request: Request, env: EdgeEnvironment) =>
  Effect.runPromise(
    openRelayPipe(request, {
      policy: env.SIDEQUEST_RELAY_POLICY === 'local' ? 'local' : 'public',
      limits: pipeLimits,
      admissions,
    }).pipe(Effect.provideService(Logger.CurrentLoggers, new Set([Logger.consoleStructured]))),
  )

export default {
  async fetch(request: Request, env: EdgeEnvironment): Promise<Response> {
    const path = new URL(request.url).pathname
    if (path === relayPipePath) return withSecurityHeaders(await relayPipe(request, env), apiPolicy)
    const headers = new Headers(request.headers)
    for (const name of request.headers.keys()) if (name.startsWith('x-sidequest-')) headers.delete(name)
    headers.set('x-sidequest-correlation-id', crypto.randomUUID())
    const forwarded = new Request(request, { headers })
    const api = isApiPath(path)
    const response = await (api ? env.API : env.WEBSITE).fetch(forwarded)
    return withSecurityHeaders(response, api ? apiPolicy : documentPolicy)
  },
}
