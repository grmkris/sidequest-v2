import { apiPolicy, documentPolicy, withSecurityHeaders } from './EdgeSecurity.ts'

type FetchService = { readonly fetch: (request: Request) => Promise<Response> }
export type EdgeEnvironment = { readonly API: FetchService; readonly WEBSITE: FetchService }

const apiNamespaces = ['/api', '/rpc', '/mcp', '/oauth', '/.well-known', '/out', '/cdn'] as const
export const isApiPath = (path: string): boolean =>
  apiNamespaces.some((namespace) => path === namespace || path.startsWith(`${namespace}/`))

export default {
  async fetch(request: Request, env: EdgeEnvironment): Promise<Response> {
    const headers = new Headers(request.headers)
    for (const name of request.headers.keys()) if (name.startsWith('x-sidequest-')) headers.delete(name)
    headers.set('x-sidequest-correlation-id', crypto.randomUUID())
    const forwarded = new Request(request, { headers })
    const api = isApiPath(new URL(request.url).pathname)
    const response = await (api ? env.API : env.WEBSITE).fetch(forwarded)
    return withSecurityHeaders(response, api ? apiPolicy : documentPolicy)
  },
}
