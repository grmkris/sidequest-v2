/**
 * The contract the Worker and the scripts share: slugs, manifests, the publish API's bodies and the limits.
 * Nothing here talks to Cloudflare.
 */
import { Schema } from 'effect'

/** A page's name, and the first segment of its address. A leading `_` keeps it off the index. */
export const Slug = Schema.String.check(Schema.isPattern(/^[a-z0-9_][a-z0-9_-]{0,79}$/u))
/** First segments of an address that are crit's own: no page may take one of these names. */
export const reservedSlugs: ReadonlyArray<string> = ['p', 's', 'api', 'mcp', 'lib', '_crit', 'cdn-cgi']
/** Who may open a page: signed-in members only, or anyone at `/p/<slug>/`. */
export const Visibility = Schema.Literals(['team', 'public'])
export type Visibility = typeof Visibility.Type
export const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u))

export const maxFileBytes = 25 * 1024 * 1024
export const maxPageBytes = 500 * 1024 * 1024
export const maxFiles = 2000

/** A path inside a version: relative, forward slashes, no `..`, no leading slash. */
const FilePath = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(512),
  Schema.isPattern(/^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[^\0\\]+$/u),
)

export const ManifestEntry = Schema.Struct({
  path: FilePath,
  sha256: Sha256,
  size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(maxFileBytes)),
  contentType: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
})
export type ManifestEntry = typeof ManifestEntry.Type

export const Manifest = Schema.Array(ManifestEntry).check(Schema.isMinLength(1), Schema.isMaxLength(maxFiles))
export type Manifest = typeof Manifest.Type

export const PublishRequest = Schema.Struct({
  page: Slug,
  manifest: Manifest,
  /** Publish although a file looks like it holds a secret. The version records that it was said. */
  allowSecrets: Schema.optionalKey(Schema.Boolean),
  /** Open the page to anyone, or close it to the team. Absent: a new page is the team's, an old one stays as it is. */
  visibility: Schema.optionalKey(Visibility),
})
export const PlanResponse = Schema.Struct({ missing: Schema.Array(Sha256) })

/** The header that makes a commit safe to retry: a replay answers with the version the first call made. */
export const idempotencyHeader = 'idempotency-key'
export const IdempotencyKey = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.:-]{16,200}$/u))

export const PageView = Schema.Struct({
  slug: Slug,
  version: Schema.Int,
  title: Schema.String,
  description: Schema.String,
  date: Schema.String,
  tags: Schema.Array(Schema.String),
  updatedAt: Schema.String,
  visibility: Visibility,
  /** How many share links open the page now. */
  links: Schema.Int,
  /** Kept pages never expire. */
  keep: Schema.Boolean,
  /** When the page takes itself down, if the site has an expiry and the page is not kept. */
  expiresAt: Schema.NullOr(Schema.String),
})
export type PageView = typeof PageView.Type

export const CommitResponse = Schema.Struct({ page: PageView, replayed: Schema.Boolean })
export const PagesResponse = Schema.Struct({ pages: Schema.Array(PageView) })
/** A share link ends after `days` (a fraction is fine); 0 never ends; absent takes the site's `linkDays`. */
export const LinkRequest = Schema.Struct({
  days: Schema.optionalKey(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(3650))),
})
/** A share link's public name: 16 hex characters, safe to show, enough to revoke that one link. */
export const LinkId = Schema.String.check(Schema.isPattern(/^[0-9a-f]{16}$/u))
/** A new share link: the token is shown once and stored only as a hash; the id names the link afterwards. */
export const LinkResponse = Schema.Struct({ id: LinkId, url: Schema.String, expiresAt: Schema.NullOr(Schema.String) })
export const LinkView = Schema.Struct({
  id: LinkId,
  createdAt: Schema.String,
  expiresAt: Schema.NullOr(Schema.String),
})
export type LinkView = typeof LinkView.Type
export const LinksResponse = Schema.Struct({ links: Schema.Array(LinkView) })
export const VisibilityRequest = Schema.Struct({ visibility: Visibility })
export const KeepRequest = Schema.Struct({ keep: Schema.Boolean })
export const KeepResponse = Schema.Struct({ page: PageView })
/** One clean-up run: pages that expired, and files no version uses any more. */
export const SweepResponse = Schema.Struct({ expired: Schema.Int, blobs: Schema.Int })
export const RevokeResponse = Schema.Struct({ revoked: Schema.Int })
export const ErrorBody = Schema.Struct({ error: Schema.String, detail: Schema.optionalKey(Schema.String) })
