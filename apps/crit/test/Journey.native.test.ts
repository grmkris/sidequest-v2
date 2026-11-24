/**
 * The Worker in workerd with local D1 and R2 (`ALCHEMY_TEST_DEV=1`), made by the same `resources` a project deploys.
 * There is no Cloudflare Access under local dev, so the test stands in for it: it hands the Worker its own public
 * keys and signs the tokens a member's requests carry (AccessTokens.ts). One journey: publish through the scripts'
 * client, serve to a member, share by link, ranges and conditionals, an idempotent replay, what each address answers
 * to whom, opening a page to the public and closing it, the team's controls, revoke, remove. Comments are
 * CommentsJourney.ts's part, expiry, the clean-up and the server's guards are HygieneJourney.ts's, and MCP is
 * McpJourney.ts's.
 */
import { expect } from 'bun:test'
import * as Cloudflare from '@alchemy.run/cloudflare'
import * as Test from 'alchemy/Test/Bun'
import * as Alchemy from 'alchemy'
import { Effect, Schema } from 'effect'
import type { SiteConfig } from '../crit.config.ts'
import { call, type Instance } from '../scripts/client.ts'
import type { PageFile } from '../scripts/guards.ts'
import { commit, manifestOf, publish } from '../scripts/publisher.ts'
import { randomToken } from '../src/Crypto.ts'
import { KeepResponse, LinkResponse, LinksResponse, PagesResponse, RevokeResponse } from '../src/Model.ts'
import { resources } from '../stack.ts'
import { makeSigner } from './AccessTokens.ts'
import { refusal, status } from './Calls.ts'
import { afterRemoval, commenting, onPublicPage, type Seat, viewOnly } from './CommentsJourney.ts'
import { hygiene } from './HygieneJourney.ts'
import { overMcp } from './McpJourney.ts'

const publishToken = `${randomToken()}${randomToken()}`
process.env['CRIT_PUBLISH_TOKEN'] = publishToken

const audience = 'a'.repeat(64)
const team = 'https://crit-native.cloudflareaccess.com'
const access = await makeSigner()
const stranger = await makeSigner()
const soon = () => Math.floor(Date.now() / 1000) + 600
const tokenFor = (email: string, over: { aud?: string; exp?: number } = {}) =>
  access.sign({ email, aud: over.aud ?? audience, iss: team, exp: over.exp ?? soon() })

const site: SiteConfig = {
  name: 'crit-native',
  title: 'Native team',
  lead: 'The journey test.',
  account: '00000000000000000000000000000000',
  domain: undefined,
  access: { kind: 'cloudflare', team, emails: ['mira@example.com'], sessionDuration: '720h' },
  publicPages: true,
  outsiders: 'comment',
  expiryDays: 0,
  linkDays: 30,
  names: { 'mira@example.com': 'Mira' },
  credentials: '.local/cloud.env',
  publishEnv: '.local/crit.env',
}

const Stack = Alchemy.Stack(
  'CritNative',
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  resources(site, { access: { jwks: access.jwks, audience, team } }),
)

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  stage: 'crit-native',
  dev: true,
  providers: Cloudflare.providers(),
  state: Alchemy.localState(),
  // The test never reaches a real account.
  sidecar: { omitEnv: ['CLOUDFLARE_'] },
})

/**
 * A site without Access (no team side), with public pages off and visitors who only read. Its pages expire after
 * three seconds and its clean-up does not wait.
 */
const Brief = Alchemy.Stack(
  'CritNativeBrief',
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  resources(
    {
      ...site,
      name: 'crit-native-brief',
      access: { kind: 'none' },
      publicPages: false,
      outsiders: 'view',
      expiryDays: 3 / 86_400,
      linkDays: 0,
    },
    { blobGraceHours: 0 },
  ),
)

const stack = beforeAll(deploy(Stack), { timeout: 180_000 })
const brief = beforeAll(deploy(Brief), { timeout: 180_000 })
afterAll(destroy(Brief), { timeout: 60_000 })
afterAll(destroy(Stack), { timeout: 60_000 })

const bytes = (value: string) => new TextEncoder().encode(value)
const film = new Uint8Array(1000).map((_, index) => index % 251)
const html = `<!doctype html><title>Spike &amp; film</title><meta name="description" content="A film to review.">
<meta name="date" content="2026-11-13"><meta name="tags" content="kris.gg, lab"><h1>Spike</h1><video src="media/film.mp4"></video>`
const files: ReadonlyArray<PageFile> = [
  { path: 'index.html', bytes: bytes(html), contentType: 'text/html; charset=utf-8' },
  { path: 'media/film.mp4', bytes: film, contentType: 'video/mp4' },
  { path: 'notes/index.html', bytes: bytes('<h1>Notes</h1>'), contentType: 'text/html; charset=utf-8' },
  { path: 'sub/page.html', bytes: bytes('<h1>A page inside</h1>'), contentType: 'text/html; charset=utf-8' },
]

const get = (url: string, headers: Record<string, string> = {}) => fetch(url, { redirect: 'manual', headers })
const linkFor = async (to: Instance, slug: string): Promise<string> =>
  Schema.decodeUnknownSync(LinkResponse)(await call(to, { method: 'POST', path: `/api/pages/${slug}/links` })).url

const publishing = async (to: Instance) => {
  expect(await status(`${to.url}/api/pages`)).toBe(401)
  expect(await status(`${to.url}/api/pages`, { headers: { authorization: 'Bearer wrong' } })).toBe(401)
  const first = await publish(to, 'spike', files)
  expect(first.uploaded).toBe(4)
  expect(first.page).toMatchObject({ version: 1, title: 'Spike & film', description: 'A film to review.' })
  expect(first.page.date).toBe('2026-11-13')
  const again = await publish(to, 'spike', files)
  expect(again.uploaded).toBe(0)
  expect(again.page.version).toBe(2)

  const manifest = await manifestOf(files)
  const key = `native-${randomToken()}`
  const made = await commit(to, 'spike', manifest, key)
  const replay = await commit(to, 'spike', manifest, key)
  expect([made.replayed, replay.replayed]).toEqual([false, true])
  expect(replay.page.version).toBe(made.page.version)
  expect(await refusal(commit(to, 'other', manifest, key))).toBe('409 idempotency_key_reused')

  const wrong = 'a'.repeat(64)
  expect(await refusal(call(to, { method: 'PUT', path: `/api/blobs/${wrong}`, bytes: bytes('not that') }))).toBe(
    '400 hash_mismatch',
  )
  const unknown = [{ path: 'index.html', sha256: 'b'.repeat(64), size: 3, contentType: 'text/html' }]
  expect(await refusal(commit(to, 'ghost', unknown, `native-${randomToken()}`))).toBe('409 blobs_missing')
  // crit's own first segments are never a page's name.
  for (const name of ['p', 's', 'api', 'mcp', 'lib', '_crit', 'cdn-cgi']) {
    expect(await refusal(commit(to, name, manifest, `native-${randomToken()}`)), name).toBe('422 reserved_name')
  }
}

const sharing = async (to: Instance) => {
  const link = await linkFor(to, 'spike')
  expect(link).toMatch(/\/s\/[A-Za-z0-9_-]{22}\/spike\/$/u)
  const page = await get(link)
  expect(page.status).toBe(200)
  expect(page.headers.get('x-robots-tag')).toContain('noindex')
  expect(page.headers.get('referrer-policy')).toBe('no-referrer')
  expect(page.headers.get('x-content-type-options')).toBe('nosniff')
  expect(page.headers.get('service-worker-allowed')).toBeNull()
  expect(await page.text()).toContain('<h1>Spike</h1>')
  const etag = page.headers.get('etag') ?? ''

  const ranged = await get(`${link}media/film.mp4`, { range: 'bytes=0-99' })
  expect(ranged.status).toBe(206)
  expect(ranged.headers.get('content-range')).toBe('bytes 0-99/1000')
  expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(film.slice(0, 100))
  const tail = await get(`${link}media/film.mp4`, { range: 'bytes=-10' })
  expect(tail.headers.get('content-range')).toBe('bytes 990-999/1000')
  const beyond = await get(`${link}media/film.mp4`, { range: 'bytes=5000-' })
  expect(beyond.status).toBe(416)
  expect(beyond.headers.get('content-range')).toBe('bytes */1000')
  expect(await status(link, { headers: { 'if-none-match': etag } })).toBe(304)
  expect(await status(link, { headers: { 'if-match': '"something-else"' } })).toBe(412)
  expect(await status(link, { method: 'HEAD' })).toBe(200)

  const folder = await get(`${link.replace(/\/$/u, '')}?backdrop=refract`)
  expect(folder.status).toBe(301)
  expect(folder.headers.get('location')).toBe(`${new URL(link).pathname}?backdrop=refract`)
  expect((await get(`${link}notes?tab=2`)).headers.get('location')).toBe(`${new URL(link).pathname}notes/?tab=2`)
  expect(await status(`${link}notes/`)).toBe(200)
  expect(await status(`${link}missing.png`)).toBe(404)

  // A link opens its own page and nothing else.
  await publish(to, 'other', [files[0] ?? { path: 'index.html', bytes: bytes('x'), contentType: 'text/html' }])
  expect(await status(link.replace('/spike/', '/other/'))).toBe(404)
  expect(await status(`${to.url}/s/${randomToken()}/spike/`)).toBe(404)
  return link
}

/** What each address answers to whom: a member, nobody, and tokens Access would never have issued for this site. */
const addresses = async (to: Instance, member: Record<string, string>, link: string) => {
  const index = await get(`${to.url}/`, member)
  expect(index.status).toBe(200)
  expect(index.headers.get('cross-origin-resource-policy')).toBe('same-origin')
  const listing = await index.text()
  expect(listing).toContain('Native team')
  expect(listing).toContain('Spike &amp; film')
  expect(listing).toContain('1 share link')
  expect(listing).toContain('team only')
  expect(listing).toContain('href="/?tag=kris.gg"')
  const filtered = await (await get(`${to.url}/?tag=kris.gg`, member)).text()
  expect(filtered).toContain('Spike &amp; film')
  const emptyFilter = await (await get(`${to.url}/?tag=none`, member)).text()
  expect(emptyFilter).not.toContain('Spike &amp; film')
  expect(await status(`${to.url}/spike/`, { headers: member })).toBe(200)
  expect(await status(`${to.url}/spike/media/film.mp4`, { headers: { ...member, range: 'bytes=0-9' } })).toBe(206)
  expect(await status(`${to.url}/spike`, { headers: member })).toBe(301)
  expect(await status(`${to.url}/spike/`, { method: 'POST', headers: member })).toBe(405)
  expect(await status(`${to.url}/nothing-here/`, { headers: member })).toBe(404)

  // Nobody, and everyone Access did not admit to this site, gets nothing private.
  const others: Record<string, Record<string, string>> = {
    'no token': {},
    'another application': { 'cf-access-jwt-assertion': await tokenFor('mira@example.com', { aud: 'b'.repeat(64) }) },
    expired: { 'cf-access-jwt-assertion': await tokenFor('mira@example.com', { exp: soon() - 1200 }) },
    'another key': {
      'cf-access-jwt-assertion': await stranger.sign({
        email: 'mira@example.com',
        aud: audience,
        iss: team,
        exp: soon(),
      }),
    },
  }
  const privatePaths = ['/', '/spike/', '/spike/media/film.mp4', '/spike/_crit/comments?page=spike', '/nothing-here/']
  for (const [who, headers] of Object.entries(others)) {
    for (const path of privatePaths) expect(await status(`${to.url}${path}`, { headers }), `${who} ${path}`).toBe(403)
    const press = await status(`${to.url}/_crit/pages/spike/visibility`, { method: 'POST', headers })
    expect(press, who).toBe(403)
  }

  // A page the team has not opened is not public, `/p` and `/s` alone are nobody's, and the open paths need no token.
  for (const path of ['/p/spike/', '/p/spike/media/film.mp4', '/p', '/s', '/p/', '/s/']) {
    expect(await status(`${to.url}${path}`), path).toBe(404)
  }
  expect(await status(link)).toBe(200)
  expect(await status(`${to.url}/api/pages`, { headers: member })).toBe(401)
  expect(await status(`${to.url}/mcp`, { method: 'POST', headers: member, body: '{}' })).toBe(401)
  const pele = await get(`${to.url}/lib/pele.js`)
  expect(pele.status).toBe(200)
  expect(pele.headers.get('content-type')).toContain('text/javascript')
  expect(await pele.text()).toContain('Pele 1.13.0')
  expect((await get(`${to.url}/lib/diagrams.js`)).headers.get('content-type')).toContain('text/javascript')
  expect((await get(`${to.url}/lib/base.css`)).headers.get('content-type')).toContain('text/css')
  expect(await status(`${to.url}/lib/nothing.js`)).toBe(404)
}

const visibilityOf = async (to: Instance, slug: string, visibility: 'team' | 'public') =>
  Schema.decodeUnknownSync(KeepResponse)(
    await call(to, { method: 'POST', path: `/api/pages/${slug}/visibility`, json: { visibility } }),
  ).page.visibility

/** A page opened to anyone by the agent's API, kept open across a publish, and closed again. */
const opening = async (to: Instance, member: Record<string, string>) => {
  expect(await visibilityOf(to, 'spike', 'public')).toBe('public')
  const page = await get(`${to.url}/p/spike/`)
  expect(page.status).toBe(200)
  expect(page.headers.get('x-robots-tag')).toContain('noindex')
  expect(page.headers.get('cross-origin-resource-policy')).toBeNull()
  expect(await page.text()).toContain('<h1>Spike</h1>')
  expect(await status(`${to.url}/p/spike/media/film.mp4`, { headers: { range: 'bytes=0-9' } })).toBe(206)
  expect((await get(`${to.url}/p/spike`)).headers.get('location')).toBe('/p/spike/')
  expect((await get(`${to.url}/p/spike/notes`)).headers.get('location')).toBe('/p/spike/notes/')
  expect(await status(`${to.url}/p/spike/`, { method: 'POST' })).toBe(405)
  // The team's address stays the team's: public does not mean the private address opens.
  expect(await status(`${to.url}/spike/`)).toBe(403)
  expect(await status(`${to.url}/p/other/`)).toBe(404)
  expect(await status(`${to.url}/p/nothing-here/`)).toBe(404)

  // A publish that says nothing keeps the page as it is; one that says `team` closes it.
  expect((await publish(to, 'spike', files)).page.visibility).toBe('public')
  expect(await status(`${to.url}/p/spike/`)).toBe(200)
  expect((await publish(to, 'spike', files, { visibility: 'team' })).page.visibility).toBe('team')
  expect(await status(`${to.url}/p/spike/`)).toBe(404)
  expect((await publish(to, 'spike', files, { visibility: 'public' })).page.visibility).toBe('public')
  expect(
    await refusal(call(to, { method: 'POST', path: '/api/pages/ghost/visibility', json: { visibility: 'public' } })),
  ).toBe('404 page_not_found')
  const listing = await (await get(`${to.url}/`, member)).text()
  expect(listing).toContain('<span class="badge">public</span>')
  expect(listing).toContain('/p/spike/')
}

/** The index's buttons: plain forms a member posts from the site itself. */
const controls = async (to: Instance, member: Record<string, string>) => {
  const press = (path: string, fields: Record<string, string>, headers: Record<string, string>) =>
    fetch(`${to.url}/_crit/pages/${path}`, {
      method: 'POST',
      redirect: 'manual',
      headers: { ...member, 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams(fields).toString(),
    })
  const here = { origin: to.url }
  // A press must come from this site: a form on another site, or one that does not say where it is from, is refused.
  expect(
    (await press('spike/visibility', { visibility: 'team' }, { origin: 'https://elsewhere.example' })).status,
  ).toBe(403)
  expect((await press('spike/visibility', { visibility: 'team' }, {})).status).toBe(403)
  expect(await status(`${to.url}/p/spike/`)).toBe(200)

  const closed = await press('spike/visibility', { visibility: 'team' }, here)
  expect([closed.status, closed.headers.get('location')]).toEqual([303, '/'])
  expect(await status(`${to.url}/p/spike/`)).toBe(404)
  expect((await press('spike/visibility', { visibility: 'public' }, here)).status).toBe(303)
  expect(await status(`${to.url}/p/spike/`)).toBe(200)
  expect((await press('spike/visibility', { visibility: 'everyone' }, here)).status).toBe(400)
  expect((await press('ghost/visibility', { visibility: 'public' }, here)).status).toBe(404)
  expect(await status(`${to.url}/_crit/pages/spike/visibility`, { headers: member })).toBe(405)

  // A new link is shown once, on the answer; revoking ends every link of the page.
  const made = await press('other/links', {}, here)
  expect(made.status).toBe(200)
  const shown = /href="([^"]+\/s\/[A-Za-z0-9_-]{22}\/other\/)"/u.exec(await made.text())?.[1] ?? ''
  expect(await status(shown)).toBe(200)
  expect((await press('other/links/revoke', {}, here)).status).toBe(303)
  expect(await status(shown)).toBe(404)
}

/** One link of a page is revoked by its id; the page's other links keep working. */
const oneLink = async (to: Instance) => {
  const make = async () =>
    Schema.decodeUnknownSync(LinkResponse)(await call(to, { method: 'POST', path: '/api/pages/other/links' }))
  const [first, second] = [await make(), await make()]
  const ids = async () =>
    Schema.decodeUnknownSync(LinksResponse)(
      await call(to, { method: 'GET', path: '/api/pages/other/links' }),
    ).links.map((link) => link.id)
  expect((await ids()).toSorted()).toEqual([first.id, second.id].toSorted())
  const revoked = await call(to, { method: 'DELETE', path: `/api/pages/other/links/${first.id}` })
  expect(Schema.decodeUnknownSync(RevokeResponse)(revoked).revoked).toBe(1)
  expect([await status(first.url), await status(second.url)]).toEqual([404, 200])
  expect(await ids()).toEqual([second.id])
  // A link's id is not its token, and one page's id ends nothing on another page.
  const elsewhere = await call(to, { method: 'DELETE', path: `/api/pages/spike/links/${second.id}` })
  expect(Schema.decodeUnknownSync(RevokeResponse)(elsewhere).revoked).toBe(0)
  expect(await status(second.url)).toBe(200)
}

const ending = async (to: Instance, member: Record<string, string>, link: string, guest: Seat) => {
  const revoked = await call(to, { method: 'DELETE', path: '/api/pages/spike/links' })
  expect(Schema.decodeUnknownSync(RevokeResponse)(revoked).revoked).toBe(1)
  expect(await status(link)).toBe(404)
  expect(await status(`${link}media/film.mp4`)).toBe(404)
  expect(await status(`${to.url}/spike/`, { headers: member })).toBe(200)

  const fresh = await linkFor(to, 'spike')
  expect(await status(fresh)).toBe(200)
  await call(to, { method: 'DELETE', path: '/api/pages/spike' })
  expect(await status(fresh)).toBe(404)
  expect(await status(`${to.url}/spike/`, { headers: member })).toBe(404)
  expect(await status(`${to.url}/p/spike/`)).toBe(404)
  expect(await refusal(call(to, { method: 'DELETE', path: '/api/pages/spike' }))).toBe('404 page_not_found')
  await afterRemoval(to, guest)
  const { pages } = Schema.decodeUnknownSync(PagesResponse)(await call(to, { method: 'GET', path: '/api/pages' }))
  expect(pages.map((page) => page.slug).toSorted()).toEqual(['finding', 'other'])

  // A name published again after its removal carries on from its last version number, and is the team's again.
  const back = await publish(to, 'spike', files)
  expect(back.uploaded).toBe(0)
  expect(back.page.version).toBeGreaterThan(3)
  expect(back.page.visibility).toBe('team')
  expect(await status(`${to.url}/spike/`, { headers: member })).toBe(200)
  expect(await status(`${to.url}/p/spike/`)).toBe(404)
}

test(
  'publishes, serves the team and the public and by link, guards every private address, and lets people decide',
  Effect.gen(function* () {
    const { url } = yield* stack
    const to: Instance = { url: url.replace(/\/+$/u, ''), token: publishToken }
    yield* Effect.promise(async () => {
      const member = { 'cf-access-jwt-assertion': await tokenFor('Mira@Example.com') }
      await publishing(to)
      const link = await sharing(to)
      await addresses(to, member, link)
      const guest = await commenting(to, member, link)
      await opening(to, member)
      await onPublicPage(to, member)
      await controls(to, member)
      await oneLink(to)
      await overMcp(to)
      await ending(to, member, link, guest)
    })
  }),
  { timeout: 180_000 },
)

test(
  'a site without Access has no team side, opens no page when public pages are off, and its visitors only read',
  Effect.gen(function* () {
    const { url } = yield* brief
    const to: Instance = { url: url.replace(/\/+$/u, ''), token: publishToken }
    yield* Effect.promise(async () => {
      await publish(to, 'spike', files)
      const forged = { 'cf-access-jwt-assertion': await tokenFor('mira@example.com') }
      for (const path of ['/', '/spike/', '/spike/_crit/comments?page=spike', '/p/spike/']) {
        expect(await status(`${to.url}${path}`), path).toBe(404)
        expect(await status(`${to.url}${path}`, { headers: forged }), path).toBe(404)
      }
      expect(await refusal(publish(to, 'spike', files, { visibility: 'public' }))).toBe('422 public_pages_off')
      const open = call(to, { method: 'POST', path: '/api/pages/spike/visibility', json: { visibility: 'public' } })
      expect(await refusal(open)).toBe('422 public_pages_off')
      await viewOnly(await linkFor(to, 'spike'))
      await call(to, { method: 'DELETE', path: '/api/pages/spike' })
    })
  }),
  { timeout: 60_000 },
)

test(
  'pages and links expire, kept pages stay, the clean-up takes old versions and unused files, and the Worker guards',
  Effect.gen(function* () {
    const { url } = yield* brief
    yield* Effect.promise(() => hygiene({ url: url.replace(/\/+$/u, ''), token: publishToken }))
  }),
  { timeout: 120_000 },
)
