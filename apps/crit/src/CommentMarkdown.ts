/** The comments as Markdown, which is how agents read them: grouped by page, then thread, open threads first. */
import type { AgentThread, CommentView } from './CommentModel.ts'

const oneLine = (text: string): string => text.replaceAll(/\s+/gu, ' ').trim()

const when = (iso: string): string => iso.slice(0, 16).replace('T', ' ')

const who = (comment: CommentView): string =>
  comment.authorKind === 'member' ? comment.author : `${comment.author} (${comment.authorKind})`

/** A body keeps its lines, indented under its bullet. */
const bodyOf = (comment: CommentView, indent: string): string =>
  comment.body
    .trim()
    .split('\n')
    .map((line) => `${indent}  ${line}`)
    .join('\n')

const comment = (item: CommentView, indent: string): string =>
  `${indent}- **${who(item)}**, ${when(item.createdAt)}:\n${bodyOf(item, indent)}`

const thread = (item: AgentThread): string => {
  const state = item.root.status === 'open' ? 'open' : `resolved by ${item.root.statusBy ?? 'someone'}`
  const anchor = oneLine(item.root.anchorText) === '' ? item.root.anchor : oneLine(item.root.anchorText)
  return [
    `### "${anchor.slice(0, 160)}" [${state}]`,
    `thread \`${item.root.id}\``,
    '',
    comment(item.root, ''),
    ...item.replies.map((reply) => comment(reply, '  ')),
  ].join('\n')
}

/** `linkBase` is where a person opens pages signed in (the team's address), when the site has a team side. */
export const threadsMarkdown = (threads: ReadonlyArray<AgentThread>, linkBase: string | undefined): string => {
  if (threads.length === 0) return 'No comments.\n'
  const open = threads.filter((item) => item.root.status === 'open').length
  const pages = [...new Set(threads.map((item) => item.page))]
  const sections = pages.map((page) => {
    const own = threads.filter((item) => item.page === page)
    const first = own[0]
    const title = first === undefined || first.pageTitle === '' ? page : `${first.pageTitle} (${page})`
    const removed = first?.removed === true ? ' — this page was taken down' : ''
    const link = linkBase === undefined || first?.removed === true ? '' : `\n${linkBase}/${page}`
    const ordered = [
      ...own.filter((item) => item.root.status === 'open'),
      ...own.filter((item) => item.root.status !== 'open'),
    ]
    return `## ${title}${removed}${link}\n\n${ordered.map(thread).join('\n\n')}`
  })
  const reply =
    'Reply with the `comment_reply` tool, or with `bun run comments reply <thread> "…"` in the repository. People resolve threads; agents do not.'
  return `# Comments: ${open} open of ${threads.length} threads\n\n${reply}\n\n${sections.join('\n\n')}\n`
}
