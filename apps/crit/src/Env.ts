/** The bindings the Worker gets from stack.ts. */
export interface Env {
  readonly DB: D1Database
  readonly BLOBS: R2Bucket
  readonly TITLE: string
  readonly LEAD: string
  /** What a visitor (by a share link, or on a public page) may do: `none`, `view` or `comment`. */
  readonly OUTSIDERS: string
  /** `on` when pages may be made public; anything else and no page is served at `/p/…`, whatever its row says. */
  readonly PUBLIC_PAGES?: string
  /**
   * The team side, present only when the site has Cloudflare Access: the audience tag of the Access application on
   * the host, and the Zero Trust organization that signs its tokens (`https://<team>.cloudflareaccess.com`). Without
   * them there is no team side, and every private address answers "not here".
   */
  readonly ACCESS_AUD?: string
  readonly ACCESS_TEAM?: string
  /** Tests only: the keys to check tokens against, as a JWKS, in place of the organization's (stack.ts refuses it in a deploy). */
  readonly ACCESS_JWKS?: string
  /** Display names by the email Access admitted, as JSON (`{ "a@b.c": "Ana" }`). */
  readonly NAMES?: string
  /** Days until a page that is not kept takes itself down; absent or `0` is never. */
  readonly EXPIRY_DAYS?: string
  /** Days a new share link works when the caller names none; absent or `0` is until revoked. */
  readonly LINK_DAYS?: string
  /** Hours an unused file is left alone by the clean-up, so a publish in flight never loses it. Default 24. */
  readonly BLOB_GRACE_HOURS?: string
  /** The secret the agents' API and `/mcp` accept as a bearer token. */
  readonly PUBLISH_TOKEN?: string
}

/** Whether this site has a team side: both Access values are set. */
export const hasTeam = (env: Env): boolean => (env.ACCESS_AUD ?? '') !== '' && (env.ACCESS_TEAM ?? '') !== ''
