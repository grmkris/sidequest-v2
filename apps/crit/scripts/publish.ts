/**
 * Publishes pages: live as soon as the upload ends, with no build, deploy, merge or CI. Only changed files are sent,
 * and a page is never half-published. Markdown files are rendered on the way (scripts/pagefiles.ts).
 *
 *   bun run publish <slug>…                  publish pages/<slug>/
 *   bun run publish <slug> --from <path>     publish a folder or a Markdown file from anywhere; the path is
 *                                            relative to this folder, e.g. ../../docs/plan.md, or absolute
 *   bun run publish <slug> --public          publish and open the page to anyone at /p/<slug>/ (the site must allow
 *                                            public pages); --team closes it again. Neither: it stays as it is
 *   bun run publish <slug> --allow-secrets   publish although a file looks like it holds a secret (it is recorded)
 *   bun run publish --remove <slug>…         take pages down (their share links stop working)
 */
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Schema } from 'effect'
import { parseTags } from '../src/Meta.ts'
import { Slug } from '../src/Model.ts'
import { parseArgs } from './args.ts'
import { call, instance } from './client.ts'
import { check } from './guards.ts'
import { pageFilesOf } from './pagefiles.ts'
import { publish } from './publisher.ts'

const pagesDir = join(import.meta.dir, '..', 'pages')
const args = parseArgs(process.argv.slice(2), ['--from', '--tag'])
const removing = args.flags.has('--remove')
const allowSecrets = args.flags.has('--allow-secrets')
const visibility = args.flags.has('--public') ? 'public' : args.flags.has('--team') ? 'team' : undefined
const from = args.values.get('--from')
const tags = parseTags(args.values.get('--tag') ?? '')
const slugs = args.words
const usage =
  'Usage: bun run publish [--remove] <slug>… | <slug> --from <folder or file.md> [--tag a,b] [--public | --team] [--allow-secrets]'
if (slugs.length === 0 || (from !== undefined && (from === '' || slugs.length !== 1))) throw new Error(usage)
// A plain yes or no, so the refusal can still name what was typed.
const isSlug = (text: string): boolean => Schema.is(Slug)(text)
for (const slug of slugs) {
  if (!isSlug(slug)) throw new Error(`${slug}: a page name is lower-case letters, digits, - and _`)
}

const to = instance()
const today = new Date().toISOString().slice(0, 10)

const publishOne = async (slug: string): Promise<void> => {
  // `--from` is relative to this folder (where `bun run --cwd` puts the command), or absolute.
  const target = from === undefined ? join(pagesDir, slug) : resolve(from)
  if (!existsSync(target)) throw new Error(from === undefined ? `No folder pages/${slug}/` : `Nothing at ${target}`)
  const files = pageFilesOf(target, { today, tags })
  const problems = check(files, { allowSecrets })
  if (problems.length > 0) throw new Error(`${slug} was not published:\n  ${problems.join('\n  ')}`)
  const result = await publish(to, slug, files, { allowSecrets, ...(visibility === undefined ? {} : { visibility }) })
  console.log(`${slug}: version ${result.page.version}, ${result.uploaded} of ${files.length} files uploaded`)
  if (result.page.visibility === 'public') console.log(`${slug}: public at ${to.url}/p/${slug}/`)
}

for (const slug of slugs) {
  if (removing) {
    await call(to, { method: 'DELETE', path: `/api/pages/${slug}` })
    console.log(`${slug}: removed`)
  } else {
    await publishOne(slug)
  }
}
