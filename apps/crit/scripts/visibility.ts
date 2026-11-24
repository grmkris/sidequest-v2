/**
 * Opens a page to anyone, or closes it to the team. A public page opens without signing in at `/p/<slug>/`; the team
 * keeps opening it at `/<slug>/`. A public page is public: never open a page that holds private or personal data.
 * The site must allow public pages (`publicPages` in crit.config.ts).
 *
 *   bun run visibility <slug> public
 *   bun run visibility <slug> team
 */
import { Schema } from 'effect'
import { KeepResponse, Slug, Visibility } from '../src/Model.ts'
import { call, instance } from './client.ts'

const [slug, wanted] = process.argv.slice(2)
if (slug === undefined || !Schema.is(Slug)(slug) || !Schema.is(Visibility)(wanted)) {
  throw new Error('Usage: bun run visibility <slug> public|team')
}

const to = instance()
const answer = await call(to, { method: 'POST', path: `/api/pages/${slug}/visibility`, json: { visibility: wanted } })
const { page } = Schema.decodeUnknownSync(KeepResponse)(answer)
console.log(page.visibility === 'public' ? `${slug}: public at ${to.url}/p/${slug}/` : `${slug}: the team only`)
