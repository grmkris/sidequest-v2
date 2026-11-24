/**
 * What people wrote on the pages, for agents: read the threads, then answer. People resolve threads; agents do not.
 *
 *   bun run comments                       open threads on every page, as Markdown
 *   bun run comments <slug>                one page's (a page inside it: <slug>/sub/page.html)
 *   bun run comments [<slug>] --all        resolved threads too
 *   bun run comments [<slug>] --json       the same as JSON
 *   bun run comments reply <thread> "…"    answer a thread (its id is in the listing); --as <name> signs it
 */
import { Schema } from 'effect'
import { CommentId, CommentView, PageId } from '../src/CommentModel.ts'
import { parseArgs } from './args.ts'
import { call, instance, read } from './client.ts'

const args = parseArgs(process.argv.slice(2), ['--as'])
const flag = (name: string): boolean => args.flags.has(name)
const signer = args.values.get('--as')
const { words } = args
const to = instance()
// A plain yes or no, so the refusal can still name what was typed.
const isPage = (text: string): boolean => Schema.is(PageId)(text)

if (words[0] === 'reply') {
  const [, thread, body] = words
  if (thread === undefined || !Schema.is(CommentId)(thread) || body === undefined || body.trim() === '') {
    throw new Error('Usage: bun run comments reply <thread> "…" [--as <name>]')
  }
  const answer = await call(to, {
    method: 'POST',
    path: `/api/comments/${thread}/replies`,
    json: signer === undefined ? { body } : { body, name: signer },
  })
  const made = Schema.decodeUnknownSync(CommentView)(answer)
  console.log(`Replied on ${made.page} as ${made.author} (${made.id})`)
} else {
  const page = words[0]
  if (page !== undefined && !isPage(page)) throw new Error(`Not a page: ${page}`)
  const query = new URLSearchParams({ status: flag('--all') ? 'all' : 'open' })
  if (page !== undefined) query.set('page', page)
  const wanted = flag('--json') ? 'application/json' : 'text/markdown'
  process.stdout.write(await read(to, `/api/comments?${query.toString()}`, wanted))
}
