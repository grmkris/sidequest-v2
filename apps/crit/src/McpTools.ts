/**
 * crit's tools for MCP clients (Mcp.ts serves them at `/mcp`): the same things the scripts do,
 * for an agent that has no files or shell. Every tool ends in the code the HTTP API uses, so the guards, the limits
 * and "agents answer, people resolve" hold here too. There is no tool to resolve a thread.
 */
import { Effect, Option, Schema } from 'effect'
import { changeVisibility, makeLink, revoke } from './Api.ts'
import { filterFrom, markdownOf, replyAs, threadsFor } from './CommentApi.ts'
import { AgentReply, CommentId } from './CommentModel.ts'
import { contentTypeOf } from './ContentType.ts'
import { randomToken, sha256Hex } from './Crypto.ts'
import { type Env, hasTeam } from './Env.ts'
import { attempt, type Refused, refuse, type Unavailable } from './Http.ts'
import { LinkId, ManifestEntry, type PageView, Slug, Visibility } from './Model.ts'
import { commitVersion, storeBytes } from './Publish.ts'
import { listedPages, missingBlobs, viewOf } from './Store.ts'
import { nowIso } from './Time.ts'

const maxHtml = 1024 * 1024
const maxAsset = 512 * 1024
const maxAssets = 50

const Asset = Schema.Struct({
  path: ManifestEntry.fields.path,
  text: Schema.String.check(Schema.isMaxLength(maxAsset)),
})
const PublishInput = Schema.Struct({
  slug: Slug,
  html: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maxHtml)),
  assets: Schema.optionalKey(Schema.Array(Asset).check(Schema.isMaxLength(maxAssets))),
  allowSecrets: Schema.optionalKey(Schema.Boolean),
  public: Schema.optionalKey(Schema.Boolean),
})
const ShareInput = Schema.Struct({
  slug: Slug,
  days: Schema.optionalKey(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(3650))),
})
const RevokeInput = Schema.Struct({ slug: Slug, id: Schema.optionalKey(LinkId) })
const VisibilityInput = Schema.Struct({ slug: Slug, visibility: Visibility })
const ReadInput = Schema.Struct({
  page: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.Literals(['open', 'resolved', 'all'])),
  since: Schema.optionalKey(Schema.String),
})
const ReplyInput = Schema.Struct({ thread: CommentId, ...AgentReply.fields })

/** A tool's schema is closed: a property it does not know is a mistake the model should hear about. */
const closed = { onExcessProperty: 'error' } as const
const decodePublish = Schema.decodeUnknownOption(PublishInput, closed)
const decodeShare = Schema.decodeUnknownOption(ShareInput, closed)
const decodeRevoke = Schema.decodeUnknownOption(RevokeInput, closed)
const decodeVisibility = Schema.decodeUnknownOption(VisibilityInput, closed)
const decodeRead = Schema.decodeUnknownOption(ReadInput, closed)
const decodeReply = Schema.decodeUnknownOption(ReplyInput, closed)

/** A tool's arguments through its schema; anything else is the tool's refusal, which the model reads. */
const input = <A>(decode: (value: unknown) => Option.Option<A>, value: unknown) =>
  Option.match(decode(value), {
    onNone: () => refuse(400, 'invalid_arguments'),
    onSome: (decoded) => Effect.succeed(decoded),
  })

export interface Tool {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly inputSchema: Readonly<Record<string, unknown>>
  readonly annotations: {
    readonly readOnlyHint: boolean
    readonly destructiveHint: boolean
    readonly idempotentHint: boolean
    readonly openWorldHint: boolean
  }
  readonly run: (env: Env, origin: string, args: unknown) => Effect.Effect<string, Refused | Unavailable>
}

const object = (properties: Record<string, unknown>, required: ReadonlyArray<string>) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})
const slugProperty = { type: 'string', pattern: '^[a-z0-9_][a-z0-9_-]{0,79}$', description: "The page's name." }
const hints = (readOnlyHint: boolean, destructiveHint: boolean, idempotentHint: boolean) => ({
  readOnlyHint,
  destructiveHint,
  idempotentHint,
  openWorldHint: false,
})

const pagesList = Effect.fn('crit.mcp.pagesList')(function* (env: Env) {
  const pages = (yield* listedPages(env.DB, true)).map(viewOf)
  if (pages.length === 0) return 'No pages yet.'
  return pages
    .map((page) => {
      const life = page.keep ? 'kept' : page.expiresAt === null ? 'no expiry' : `expires ${page.expiresAt.slice(0, 10)}`
      const tags = page.tags.length === 0 ? '' : `, [${page.tags.join(', ')}]`
      return `- ${page.slug}: "${page.title}", version ${page.version}, ${page.visibility}, ${page.links} share links, ${life}${tags}`
    })
    .join('\n')
})

/** Where a page opens, for the agent to pass on: the team's address when the site has one, and the public one. */
const whereOf = (env: Env, origin: string, page: PageView): string => {
  const open = page.visibility === 'public' ? `Anyone opens it at ${origin}/p/${page.slug}/.` : ''
  const members = hasTeam(env) ? `Signed-in people open it at ${origin}/${page.slug}/.` : ''
  const said = [members, open].filter((line) => line !== '').join(' ')
  return said === ''
    ? 'This site has no team sign-in, so nobody can open the page now: make a share link with page_share, or make it public with page_visibility.'
    : said
}

const publish = Effect.fn('crit.mcp.publish')(function* (env: Env, origin: string, args: unknown) {
  const { slug, html, assets = [], allowSecrets, public: open } = yield* input(decodePublish, args)
  if (assets.some((asset) => asset.path === 'index.html')) return yield* refuse(400, 'index_html_is_the_html')
  const encoder = new TextEncoder()
  const files = [{ path: 'index.html', text: html }, ...assets].map((file) => ({
    path: file.path,
    bytes: new Uint8Array(encoder.encode(file.text)),
    contentType: contentTypeOf(file.path),
  }))
  const hashes = yield* attempt(() => Promise.all(files.map((file) => sha256Hex(file.bytes))))
  const manifest = files.map((file, index) => ({
    path: file.path,
    sha256: hashes[index] ?? '',
    size: file.bytes.byteLength,
    contentType: file.contentType,
  }))
  const missing = new Set(yield* missingBlobs(env.DB, hashes, yield* nowIso))
  for (const [index, file] of files.entries()) {
    const sha = hashes[index] ?? ''
    if (missing.delete(sha)) yield* storeBytes(env, sha, file.bytes)
  }
  const wanted: Visibility | undefined = open === undefined ? undefined : open ? 'public' : 'team'
  const request = {
    page: slug,
    manifest,
    ...(allowSecrets === true ? { allowSecrets: true } : {}),
    ...(wanted === undefined ? {} : { visibility: wanted }),
  }
  const made = yield* commitVersion(env, request, `mcp-${randomToken()}`)
  return `Published ${slug}, version ${made.page.version} (${files.length} files). ${whereOf(env, origin, made.page)}`
})

const visibility = Effect.fn('crit.mcp.visibility')(function* (env: Env, origin: string, args: unknown) {
  const wanted = yield* input(decodeVisibility, args)
  const page = yield* changeVisibility(env, wanted.slug, wanted.visibility, 'agent')
  return `${page.slug} is now ${page.visibility}. ${whereOf(env, origin, page)}`
})

const share = Effect.fn('crit.mcp.share')(function* (env: Env, origin: string, args: unknown) {
  const { slug, days } = yield* input(decodeShare, args)
  const link = yield* makeLink(env, origin, slug, days)
  const life = link.expiresAt === null ? 'until it is revoked' : `until ${link.expiresAt.slice(0, 10)}`
  return `${link.url}\nAnyone with this link opens the page without signing in, ${life}. It is shown only now. Link id: ${link.id} (for link_revoke).`
})

const read = Effect.fn('crit.mcp.read')(function* (env: Env, origin: string, args: unknown) {
  const filter = yield* filterFrom(yield* input(decodeRead, args))
  return markdownOf(env, origin, yield* threadsFor(env, filter))
})

const reply = Effect.fn('crit.mcp.reply')(function* (env: Env, args: unknown) {
  const { thread, ...answer } = yield* input(decodeReply, args)
  const made = yield* replyAs(env, thread, answer)
  return `Replied on ${made.page} as ${made.author}. A person resolves the thread.`
})

export const tools: ReadonlyArray<Tool> = [
  {
    name: 'pages_list',
    title: 'List pages',
    description: 'Every live page: name, title, version, who may open it (team or public), share links and expiry.',
    inputSchema: object({}, []),
    annotations: hints(true, false, true),
    run: (env) => pagesList(env),
  },
  {
    name: 'page_publish',
    title: 'Publish a page',
    description:
      'Publish one HTML document as a page, or a new version of it, live at once. For images, video or many files use the project\'s publish script instead. Reference /lib/base.css, /lib/pele.js + /lib/diagrams.js (Mermaid in <pre class="mermaid">) and /lib/comments.js (comments). Never include secrets or private data.',
    inputSchema: object(
      {
        slug: slugProperty,
        html: { type: 'string', maxLength: maxHtml, description: 'The whole index.html.' },
        assets: {
          type: 'array',
          maxItems: maxAssets,
          description: 'Small text files beside it (CSS, JS, SVG, JSON), referenced relatively.',
          items: object({ path: { type: 'string', maxLength: 512 }, text: { type: 'string', maxLength: maxAsset } }, [
            'path',
            'text',
          ]),
        },
        allowSecrets: {
          type: 'boolean',
          description: 'Publish although a file looks like it holds a secret. Only when a person said so.',
        },
        public: {
          type: 'boolean',
          description:
            "true: anyone opens the page at /p/<slug>/ without signing in. false: the team only, which closes a page that was public. Left out: a new page is the team's, an old one stays as it is.",
        },
      },
      ['slug', 'html'],
    ),
    annotations: hints(false, true, false),
    run: publish,
  },
  {
    name: 'page_visibility',
    title: 'Open or close a page',
    description:
      'public: anyone opens the page at /p/<slug>/ without signing in. team: signed-in members only. Only make a page public when a person asked for it and it holds no private or personal data.',
    inputSchema: object({ slug: slugProperty, visibility: { type: 'string', enum: ['team', 'public'] } }, [
      'slug',
      'visibility',
    ]),
    annotations: hints(false, false, true),
    run: visibility,
  },
  {
    name: 'page_share',
    title: 'Make a share link',
    description:
      'A new link that opens one page without signing in. It is public: only share a page with no private or personal data. The answer names the link id, which link_revoke takes to end that one link.',
    inputSchema: object(
      {
        slug: slugProperty,
        days: {
          type: 'number',
          minimum: 0,
          maximum: 3650,
          description: "Days it works; 0 is until revoked. Left out, the site's default applies.",
        },
      },
      ['slug'],
    ),
    annotations: hints(false, false, false),
    run: share,
  },
  {
    name: 'link_revoke',
    title: 'Revoke share links',
    description:
      'With id: that one share link stops working. Without: every share link of the page does. The page itself stays.',
    inputSchema: object(
      {
        slug: slugProperty,
        id: { type: 'string', pattern: '^[0-9a-f]{16}$', description: 'The link id page_share answered with.' },
      },
      ['slug'],
    ),
    annotations: hints(false, true, true),
    run: (env, _origin, args) =>
      Effect.gen(function* () {
        const { slug, id } = yield* input(decodeRevoke, args)
        return `${slug}: ${(yield* revoke(env, slug, id)).revoked} links revoked.`
      }),
  },
  {
    name: 'comments_read',
    title: 'Read comments',
    description: "What people wrote on the pages, as Markdown, grouped by page and thread, with each thread's id.",
    inputSchema: object(
      {
        page: { type: 'string', description: 'A page, or a page inside it (spike/sub/page.html). Absent: every page.' },
        status: { type: 'string', enum: ['open', 'resolved', 'all'], description: 'Default: open.' },
        since: { type: 'string', description: 'Only threads with something new at or after this ISO time.' },
      },
      [],
    ),
    annotations: hints(true, false, true),
    run: read,
  },
  {
    name: 'comment_reply',
    title: 'Reply to a thread',
    description: 'Answer a thread as an agent. Agents answer; a person resolves the thread.',
    inputSchema: object(
      {
        thread: { type: 'string', description: 'The thread id from comments_read.' },
        body: { type: 'string', minLength: 1, maxLength: 4096 },
        name: {
          type: 'string',
          maxLength: 60,
          description: "Who is answering, e.g. the agent's name. Left out: agent.",
        },
      },
      ['thread', 'body'],
    ),
    annotations: hints(false, false, false),
    run: (env, _origin, args) => reply(env, args),
  },
]
