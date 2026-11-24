/**
 * Keeps a page, so it never takes itself down, or lets it go again. Only matters when the site has an expiry
 * (`expiryDays` in crit.config.ts).
 *
 *   bun run keep <slug>         keep the page
 *   bun run keep <slug> --off   let it expire again, counted from now
 */
import { Schema } from 'effect'
import { KeepResponse, Slug } from '../src/Model.ts'
import { parseArgs } from './args.ts'
import { call, instance } from './client.ts'

const args = parseArgs(process.argv.slice(2), [])
const [slug] = args.words
if (slug === undefined || !Schema.is(Slug)(slug)) throw new Error('Usage: bun run keep <slug> [--off]')

const keep = !args.flags.has('--off')
const answer = await call(instance(), { method: 'PATCH', path: `/api/pages/${slug}`, json: { keep } })
const { page } = Schema.decodeUnknownSync(KeepResponse)(answer)
console.log(
  page.keep
    ? `${slug}: kept`
    : `${slug}: ${page.expiresAt === null ? 'not kept; the site has no expiry' : `expires ${page.expiresAt.slice(0, 10)}`}`,
)
