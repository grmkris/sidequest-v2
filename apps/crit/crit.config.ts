/**
 * Everything that differs from one project's crit to the next. Fill in every value before the first deploy (SKILL.md
 * walks through it); nothing else in this folder names a project. No secrets belong here: the Worker bundles this file.
 */
export interface SiteConfig {
  /** Names the stack, the Worker, the database (`<name>-db`) and the bucket (`<name>-blobs`). Never change it after a deploy. */
  readonly name: string
  /** The index page's heading and the line under it. */
  readonly title: string
  readonly lead: string
  /** The Cloudflare account everything is deployed to. `scripts/cloud.ts` refuses credentials for any other. */
  readonly account: string
  /**
   * The project's zone and crit's one host in it, one level below the zone (`team.example.com`). Leave undefined to
   * run on workers.dev.
   */
  readonly domain: { readonly zone: string; readonly host: string } | undefined
  /**
   * Who opens the team side (the index and every page, at `/` and `/<slug>/`).
   * - `cloudflare`: Cloudflare Access admits these emails by a code sent to them; nobody needs a Cloudflare account.
   *   `team` is the account's Zero Trust organization, `https://<team name>.cloudflareaccess.com`. On workers.dev,
   *   `emails` may be empty when `CRIT_TEAM` in the publish-env file lists the team instead (team.ts), for a project
   *   that keeps people's addresses out of its repository. `workersDevSubdomain` must name the account's workers.dev subdomain (the `acme` of `acme.workers.dev`).
   * - `none`: there is no team side. Pages open only as public pages or by share links.
   */
  readonly access:
    | {
        readonly kind: 'cloudflare'
        readonly team: string
        readonly emails: ReadonlyArray<string>
        readonly sessionDuration: string
        readonly workersDevSubdomain?: string
      }
    | { readonly kind: 'none' }
  /**
   * Whether a page may be made public: open to anyone, without signing in, at `/p/<slug>/`. Off, every request to
   * open a page is refused and no page is served there. A page is the team's until someone opens it.
   */
  readonly publicPages: boolean
  /**
   * What a visitor may do, on a public page or by a share link.
   * - `none`: read public pages; no share links at all, and visitors neither see nor write comments.
   * - `view`: also read the comment threads.
   * - `comment`: also comment, after typing a name.
   */
  readonly outsiders: 'none' | 'view' | 'comment'
  /**
   * Days until a page takes itself down, counted from its last publish; `0` is never. `bun run keep <slug>` exempts
   * a page.
   */
  readonly expiryDays: number
  /** Days a new share link works unless `share --days` says otherwise; `0` is until it is revoked. */
  readonly linkDays: number
  /** Names shown for the team, by the email Access admitted; anyone else is shown by email. `CRIT_TEAM` adds names too. */
  readonly names: Readonly<Record<string, string>>
  /**
   * Mode-600 files outside Git. A relative path is taken from this folder, whose `.gitignore` keeps `.local` out (in
   * a worktree, the main checkout's copy is used); `~/…` and absolute paths work too.
   * `credentials`: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID for `account`; only `deploy` reads it.
   * `publishEnv`: CRIT_URL (crit's address) and CRIT_PUBLISH_TOKEN; every script reads it. `deploy` also takes
   * CRIT_TEAM from it (`email=Name,email=Name`).
   */
  readonly credentials: string
  readonly publishEnv: string
}

export const site: SiteConfig = {
  name: 'sidequest-crit',
  title: 'Sidequest crit',
  lead: 'Working pages: protocol notes, plans, prototypes and reviews.',
  account: 'bceaeae4788dce3493514fde194b4a7e',
  domain: { zone: 'sidequest.exchange', host: 'crit.sidequest.exchange' },
  // Who signs in comes from CRIT_TEAM in the publish-env file, outside Git.
  access: { kind: 'cloudflare', team: 'https://kris-gg.cloudflareaccess.com', emails: [], sessionDuration: '720h' },
  publicPages: true,
  outsiders: 'comment',
  expiryDays: 0,
  linkDays: 30,
  names: {},
  credentials: '~/.config/crit/personal-cloud.env',
  publishEnv: '~/.config/crit/sidequest.env',
}
