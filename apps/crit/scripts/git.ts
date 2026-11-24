/** What the repository knows about a file: enough to turn a relative link into a GitHub link a reader can open. */
import { spawnSync } from 'node:child_process'
import path from 'node:path'

export interface RepoContext {
  readonly root: string
  /** `owner/name` on GitHub, when the origin remote is GitHub. */
  readonly github: string | undefined
  readonly commit: string
  readonly branch: string | undefined
  /** Whether the commit is on a remote branch, so a permalink to it resolves. */
  readonly pushed: boolean
  readonly dirty: boolean
}

const git = (cwd: string, args: ReadonlyArray<string>): string | undefined => {
  const result = spawnSync('git', [...args], { cwd, encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : undefined
}

export const githubSlug = (remote: string): string | undefined =>
  /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/u.exec(remote)?.[1]

export const repoContext = (target: string): RepoContext | undefined => {
  const cwd = path.dirname(path.resolve(target))
  const root = git(cwd, ['rev-parse', '--show-toplevel'])
  const commit = root === undefined ? undefined : git(root, ['rev-parse', 'HEAD'])
  if (root === undefined || commit === undefined) return undefined
  const remote = git(root, ['remote', 'get-url', 'origin'])
  return {
    root,
    github: remote === undefined ? undefined : githubSlug(remote),
    commit,
    branch: git(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
    pushed: (git(root, ['branch', '-r', '--contains', commit]) ?? '') !== '',
    dirty: (git(root, ['status', '--porcelain']) ?? '') !== '',
  }
}

/**
 * A GitHub address for a path in the repository: pinned to the commit when it is pushed, else to the branch (a reader
 * then sees the branch as it is now). Undefined when the repository is not on GitHub.
 */
export const permalink = (repo: RepoContext, repoPath: string, isDirectory: boolean): string | undefined => {
  if (repo.github === undefined) return undefined
  const ref = repo.pushed ? repo.commit : (repo.branch ?? repo.commit)
  const [file = '', hash] = repoPath.split('#', 2)
  return `https://github.com/${repo.github}/${isDirectory ? 'tree' : 'blob'}/${ref}/${file}${hash === undefined ? '' : `#${hash}`}`
}

/** The line under a rendered page that says where it came from. */
export const sourceLine = (repo: RepoContext | undefined, repoPath: string | undefined): string => {
  if (repo === undefined || repoPath === undefined) return ''
  const where = repo.github ?? path.basename(repo.root)
  const ref = repo.pushed ? repo.commit.slice(0, 8) : `${repo.branch ?? 'HEAD'} (not pushed)`
  return `From ${where} · ${repoPath} at ${ref}${repo.dirty ? ' · with uncommitted changes' : ''}`
}
