/**
 * Reads `KEY=value` lines from a mode-600 file that stays outside Git. A relative path is taken from crit's own folder
 * (the one that holds crit.config.ts), whose `.gitignore` keeps `.local` out of Git: this checkout's, or in a worktree
 * (which has no copy) the same folder of the main checkout. `~/` is the home folder; an absolute path is used as it is.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

const app = join(import.meta.dir, '..')
const git = (...args: string[]) => spawnSync('git', args, { cwd: app, encoding: 'utf8' }).stdout.trim()

export const secretFile = (path: string): string => {
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  if (isAbsolute(path)) return path
  const own = join(app, path)
  if (existsSync(own)) return own
  const repo = git('rev-parse', '--show-toplevel')
  if (repo === '') return own
  // The main checkout, from a worktree; the checkout itself otherwise.
  const main = dirname(resolve(repo, git('rev-parse', '--git-common-dir')))
  return join(main, relative(repo, app), path)
}

/** The file's values, or an empty map when it does not exist. A file other people can read is refused. */
export const readSecrets = (path: string): ReadonlyMap<string, string> => {
  const file = secretFile(path)
  const values = new Map<string, string>()
  if (!existsSync(file)) return values
  const mode = statSync(file).mode & 0o777
  if (mode !== 0o600) throw new Error(`${file} must be mode 600, not ${mode.toString(8)}`)
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/u.exec(line)
    if (match?.[1] !== undefined) values.set(match[1], (match[2] ?? '').replace(/^(['"])(.*)\1$/u, '$2'))
  }
  return values
}
