/** Lists every live page: its version, date, who may open it, share links, when it expires, and its title. `bun run pages` */
import { Schema } from 'effect'
import { PagesResponse } from '../src/Model.ts'
import { call, instance } from './client.ts'

const { pages } = Schema.decodeUnknownSync(PagesResponse)(await call(instance(), { method: 'GET', path: '/api/pages' }))
for (const page of pages) {
  const shared = page.links > 0 ? `shared (${page.links})` : '-'
  const life = page.keep ? 'kept' : page.expiresAt === null ? '-' : `until ${page.expiresAt.slice(0, 10)}`
  const date = page.date === '' ? '-' : page.date
  const tags = page.tags.length === 0 ? '-' : page.tags.join(',')
  console.log([page.slug, `v${page.version}`, date, page.visibility, shared, life, tags, page.title].join('\t'))
}
if (pages.length === 0) console.log('No pages yet.')
