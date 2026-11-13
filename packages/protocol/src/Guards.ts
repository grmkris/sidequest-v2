import { Context, Schema } from 'effect'
import { HttpApiMiddleware } from 'effect/http-api'
import { AccountId } from './Id.ts'
import { NotSignedIn, Unavailable } from './SessionApi.ts'
import { SessionCookie } from './SessionGroup.ts'

/** A state-changing request that another site, or a page the server cannot tell from one, sent. */
export class CrossSiteRequest extends Schema.TaggedError<CrossSiteRequest>()(
  'CrossSiteRequest',
  {},
  { httpApiStatus: 403 },
) {}

/**
 * Refuses a state-changing request that may come from another site, on every endpoint of the API. The session
 * cookie's `SameSite=Lax` keeps it off other sites' requests in current browsers, but not on requests from a sibling
 * subdomain (the same site) or from browsers that ignore the attribute, so the server checks where a request came
 * from itself. The rule is in the server's implementation.
 */
export class SameOrigin extends HttpApiMiddleware.Service<SameOrigin>()('Sidequest/SameOrigin', {
  error: CrossSiteRequest,
}) {}

/** The account of the person a request's session cookie names, for the endpoints {@link SignedIn} guards. */
export class SignedInAccount extends Context.Service<SignedInAccount, AccountId>()('Sidequest/SignedInAccount') {}

/** Requires the session cookie of a signed-in person, and provides their account. */
export class SignedIn extends HttpApiMiddleware.Service<SignedIn, { provides: SignedInAccount }>()(
  'Sidequest/SignedIn',
  { security: { session: SessionCookie }, error: [NotSignedIn, Unavailable] },
) {}
