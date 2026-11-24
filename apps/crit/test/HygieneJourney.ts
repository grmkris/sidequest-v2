/**
 * The clean-up part of the journey (Journey.native.test.ts), on a site whose pages expire after three seconds and
 * whose clean-up takes an unused file at once: keep, link expiry, version pruning, the sweep, and the guards the
 * Worker applies whatever the caller checked.
 */
import { expect } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Schema } from 'effect'
import { call, type Instance } from '../scripts/client.ts'
import type { PageFile } from '../scripts/guards.ts'
import { pageFilesOf } from '../scripts/pagefiles.ts'
import { commit, manifestOf, publish } from '../scripts/publisher.ts'
import { randomToken } from '../src/Crypto.ts'
import { refusal, status } from './Calls.ts'
import { KeepResponse, LinkResponse, PagesResponse, PlanResponse, SweepResponse } from '../src/Model.ts'

const page = (body: string): ReadonlyArray<PageFile> => [
  { path: 'index.html', bytes: new TextEncoder().encode(`<h1>${body}</h1>`), contentType: 'text/html; charset=utf-8' },
]
const pause = (millis: number) => new Promise((done) => setTimeout(done, millis))

const keeping = async (to: Instance, slug: string, keep: boolean) =>
  Schema.decodeUnknownSync(KeepResponse)(
    await call(to, { method: 'PATCH', path: `/api/pages/${slug}`, json: { keep } }),
  ).page
const linking = async (to: Instance, slug: string, days?: number) =>
  Schema.decodeUnknownSync(LinkResponse)(
    await call(to, { method: 'POST', path: `/api/pages/${slug}/links`, json: days === undefined ? {} : { days } }),
  )
const sweeping = async (to: Instance) =>
  Schema.decodeUnknownSync(SweepResponse)(await call(to, { method: 'POST', path: '/api/sweep' }))
/** Which of a page's files the Worker no longer holds. */
const missing = async (to: Instance, files: ReadonlyArray<PageFile>) =>
  Schema.decodeUnknownSync(PlanResponse)(
    await call(to, {
      method: 'POST',
      path: '/api/publish/plan',
      json: { page: 'probe', manifest: await manifestOf(files) },
    }),
  ).missing
const until = async (check: () => Promise<boolean>, what: string) => {
  for (let tries = 0; tries < 40; tries++) {
    if (await check()) return
    await pause(250)
  }
  throw new Error(`still waiting for ${what}`)
}

const expiring = async (to: Instance) => {
  // A kept page never expires; any other takes itself down, here after three seconds.
  const first = page('Kept, first version')
  expect((await publish(to, 'kept', first)).page.expiresAt).not.toBeNull()
  expect(await keeping(to, 'kept', true)).toMatchObject({ keep: true, expiresAt: null })
  const brief = page('Brief')
  expect((await publish(to, 'brief', brief)).page).toMatchObject({ keep: false })

  // A link ends by itself after its days; one without an end works on.
  const short = await linking(to, 'kept', 1 / 86_400)
  const lasting = await linking(to, 'kept')
  const briefLink = await linking(to, 'brief', 0)
  expect(short.expiresAt).not.toBeNull()
  expect([lasting.expiresAt, briefLink.expiresAt]).toEqual([null, null])
  expect(await status(lasting.url)).toBe(200)
  await until(async () => (await status(short.url)) === 404, 'the short link to end')
  expect(await status(lasting.url)).toBe(200)

  // The page is gone for readers the moment it expires, before any clean-up ran.
  await until(async () => (await status(briefLink.url)) === 404, 'the page to expire')
  const listed = Schema.decodeUnknownSync(PagesResponse)(await call(to, { method: 'GET', path: '/api/pages' }))
  expect(listed.pages.map((item) => item.slug)).not.toContain('brief')
  expect(await refusal(keeping(to, 'brief', true))).toBe('404 page_not_found')

  // Seven publishes of the kept page: only the last five versions keep their files.
  for (let version = 2; version <= 7; version++) await publish(to, 'kept', page(`Kept, version ${version}`))
  expect(await missing(to, first)).toEqual([])
  const swept = await sweeping(to)
  expect(swept.expired).toBeGreaterThanOrEqual(1)
  expect(swept.blobs).toBeGreaterThanOrEqual(3)
  expect(await missing(to, first)).toHaveLength(1)
  expect(await missing(to, page('Kept, version 2'))).toHaveLength(1)
  expect(await missing(to, brief)).toHaveLength(1)
  expect(await missing(to, page('Kept, version 3'))).toEqual([])
  expect(await status(lasting.url)).toBe(200)
  expect(await sweeping(to)).toEqual({ expired: 0, blobs: 0 })

  // Letting a kept page go starts its clock again.
  expect((await keeping(to, 'kept', false)).expiresAt).not.toBeNull()
}

const guarding = async (to: Instance) => {
  // The scripts' own check is skipped here, as a caller with only the token could: the Worker holds the line.
  const leaky: ReadonlyArray<PageFile> = [
    ...page('Leaky'),
    {
      path: 'notes.txt',
      bytes: new TextEncoder().encode(`token ghp_${'a'.repeat(36)}`),
      contentType: 'text/plain; charset=utf-8',
    },
  ]
  expect(await refusal(publish(to, 'leak', leaky))).toBe('422 secrets_found')
  const allowed = await publish(to, 'leak', leaky, { allowSecrets: true })
  expect(allowed.page.version).toBe(1)
  expect(allowed.uploaded).toBe(0)

  const denied = await manifestOf([{ path: '.env', bytes: new TextEncoder().encode('A=1'), contentType: 'text/plain' }])
  expect(await refusal(commit(to, 'leak', denied, `native-${randomToken()}`, { allowSecrets: true }))).toBe(
    '422 denied_path',
  )
}

/** A Markdown file published as a page, by Bun's own parser: marked blocks, a drawn diagram and its picture. */
const rendering = async (to: Instance) => {
  const folder = mkdtempSync(path.join(tmpdir(), 'crit-journey-'))
  writeFileSync(path.join(folder, 'shot.png'), new Uint8Array([137, 80, 78, 71, 0, 1, 2, 3]))
  const fence = '```'
  writeFileSync(
    path.join(folder, 'plan.md'),
    `# The plan\n\nWhat we do next. ![a shot](shot.png)\n\n${fence}mermaid\nflowchart LR\n  A --> B\n${fence}\n`,
  )
  const files = pageFilesOf(path.join(folder, 'plan.md'), { today: '2026-11-13' })
  expect(files.map((file) => file.path)).toEqual(['index.html', 'shot.png'])
  const made = await publish(to, 'plan', files)
  expect(made.page).toMatchObject({ title: 'The plan', description: 'What we do next.', date: '2026-11-13' })
  const link = (await linking(to, 'plan')).url
  const html = await (await fetch(link)).text()
  expect(html).toMatch(/<h1 id="[^"]+" data-review-id="h-[0-9a-f]{8}">The plan<\/h1>/u)
  expect(html).toMatch(/<figure class="diagram" data-review-id="d-[0-9a-f]{8}"[^>]*><svg/u)
  expect(html).toContain('<img src="shot.png" alt="a shot"')
  expect(await status(`${link}shot.png`)).toBe(200)
}

export const hygiene = async (to: Instance) => {
  await expiring(to)
  await guarding(to)
  await rendering(to)
}
