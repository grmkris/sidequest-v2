/**
 * Makes a share link for a page: anyone with it opens the page without signing in, until it ends or is revoked. The
 * link is shown once here and kept nowhere, so make a new one if it is lost; its id names it afterwards. A share
 * link is public: never share a page that holds private or personal data.
 *
 *   bun run share <slug>                a new link, for the site's `linkDays`
 *   bun run share <slug> --days 7       a link that ends in 7 days (0: until revoked)
 *   bun run share <slug> --list         the ids of the links that work now
 *   bun run share <slug> --revoke <id>  that one link stops working
 *   bun run share <slug> --revoke       every link of the page stops working
 */
import { Schema } from 'effect'
import { LinkId, LinkResponse, LinksResponse, RevokeResponse, Slug } from '../src/Model.ts'
import { parseArgs } from './args.ts'
import { call, instance } from './client.ts'

const args = parseArgs(process.argv.slice(2), ['--days'])
const given = args.values.get('--days')
const days = given === undefined ? undefined : given.trim() === '' ? Number.NaN : Number(given)
const [slug, id] = args.words
const usage = 'Usage: bun run share <slug> [--days <n>] | --list | --revoke [<id>]'
if (slug === undefined || !Schema.is(Slug)(slug) || (days !== undefined && !(days >= 0))) throw new Error(usage)
if (id !== undefined && !(args.flags.has('--revoke') && Schema.is(LinkId)(id))) throw new Error(usage)

const to = instance()
const until = (expiresAt: string | null) => (expiresAt === null ? 'until revoked' : `until ${expiresAt.slice(0, 10)}`)
if (args.flags.has('--revoke')) {
  const path = `/api/pages/${slug}/links${id === undefined ? '' : `/${id}`}`
  const answer = await call(to, { method: 'DELETE', path })
  console.log(`${slug}: ${Schema.decodeUnknownSync(RevokeResponse)(answer).revoked} links revoked`)
} else if (args.flags.has('--list')) {
  const answer = await call(to, { method: 'GET', path: `/api/pages/${slug}/links` })
  const { links } = Schema.decodeUnknownSync(LinksResponse)(answer)
  for (const link of links)
    console.log([link.id, `made ${link.createdAt.slice(0, 10)}`, until(link.expiresAt)].join('\t'))
  if (links.length === 0) console.log(`${slug}: no share links`)
} else {
  const answer = await call(to, {
    method: 'POST',
    path: `/api/pages/${slug}/links`,
    json: days === undefined ? {} : { days },
  })
  const link = Schema.decodeUnknownSync(LinkResponse)(answer)
  console.log(link.url)
  console.error(`Link ${link.id}, works ${until(link.expiresAt)}.`)
}
