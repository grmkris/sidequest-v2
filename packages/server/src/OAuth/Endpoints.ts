/** The website's consent page for an authorization request (`apps/web`). */
export const consentPath = (request: string) => `/connect/${request}`

/**
 * The cookie that binds an authorization request to the browser that opened it, so a consent link sent to someone else
 * shows them nothing to approve. `__Host-` keeps it to this origin; it lasts as long as the request.
 */
export const bindingCookieName = '__Host-sidequest-connect'
