/** The MCP endpoint, the one protected resource OAuth issues access to; the edge routes it to the API Worker. */
export const mcpPath = '/mcp' as const

/** The resource indicator (RFC 8707) of this site's MCP endpoint: its exact URL, which tokens are bound to. */
export const resourceOf = (origin: string) => `${origin}${mcpPath}`

/** RFC 9728 metadata for `/mcp`, at the well-known URI with the resource's path inserted (§3.1). */
export const protectedResourcePath = `/.well-known/oauth-protected-resource${mcpPath}` as const
/** The same document at the root form, which some clients try when the path form is absent. */
export const protectedResourceRootPath = '/.well-known/oauth-protected-resource' as const
/** RFC 8414 metadata. The issuer is this origin, with no path. */
export const authorizationServerPath = '/.well-known/oauth-authorization-server' as const

export const registerPath = '/oauth/register' as const
export const authorizePath = '/oauth/authorize' as const
export const tokenPath = '/oauth/token' as const
export const revokePath = '/oauth/revoke' as const

/** The website's consent page for an authorization request (`apps/web`). */
export const consentPath = (request: string) => `/connect/${request}`

/** Where a client finds how to get a token for this site's MCP endpoint, named in every 401 from it. */
export const protectedResourceMetadataOf = (origin: string) => `${origin}${protectedResourcePath}`

/**
 * The cookie that binds an authorization request to the browser that opened it, so a consent link sent to someone else
 * shows them nothing to approve. `__Host-` keeps it to this origin; it lasts as long as the request.
 */
export const bindingCookieName = '__Host-sidequest-connect'
