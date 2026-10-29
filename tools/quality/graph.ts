import { readFile } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { dirname, posix } from 'node:path'
import { Schema } from 'effect'
import { importsOf, sourceFiles } from './source.ts'

const Manifest = Schema.Struct({
  name: Schema.String,
  exports: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  dependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
})
type Workspace = { readonly directory: string; readonly manifest: typeof Manifest.Type }

const directions: Readonly<Record<string, readonly string[]>> = {
  '@sidequest/web': ['@sidequest/auth', '@sidequest/i18n', '@sidequest/observability', '@sidequest/protocol'],
  '@sidequest/server': [
    '@sidequest/auth',
    '@sidequest/db',
    '@sidequest/domain',
    '@sidequest/i18n',
    '@sidequest/observability',
    '@sidequest/protocol',
  ],
  // Auth writes the code email, in the person's language.
  '@sidequest/auth': ['@sidequest/db', '@sidequest/i18n'],
  // Browser-safe contracts: the typed API and the schemas assistants and the website share.
  '@sidequest/protocol': ['@sidequest/auth'],
  '@sidequest/domain': [],
  '@sidequest/db': [],
  '@sidequest/i18n': [],
  '@sidequest/observability': [],
}

const packageName = (specifier: string) =>
  specifier
    .split('/')
    .slice(0, specifier.startsWith('@') ? 2 : 1)
    .join('/')

export const checkDirection = (from: string, to: string) => {
  if (from !== to && !directions[from]?.includes(to)) throw new Error(`Forbidden dependency: ${from} -> ${to}`)
}

export const assertBrowserSafe = (file: string, specifier: string) => {
  if (
    isBuiltin(specifier) ||
    /^(node:|bun:|cloudflare:|@alchemy\.run\/cloudflare|@yielded\/auth-persistence|@effect\/sql-|drizzle-orm)/.test(
      specifier,
    ) ||
    /^packages\/(server|db)\//.test(file) ||
    /\/server\//.test(file) ||
    (file.startsWith('packages/auth/src/') &&
      !/^packages\/auth\/src\/(client|config|EmailEntryContract)\.ts$/.test(file))
  ) {
    throw new Error(`Server adapter in browser graph: ${file} -> ${specifier}`)
  }
}

const resolveWorkspace = (target: Workspace, specifier: string) => {
  const subpath = specifier === target.manifest.name ? '.' : `.${specifier.slice(target.manifest.name.length)}`
  for (const [key, value] of Object.entries(target.manifest.exports ?? {})) {
    if (key === subpath) return posix.join(target.directory, value)
    if (key.endsWith('*') && subpath.startsWith(key.slice(0, -1)))
      return posix.join(target.directory, value.replace('*', subpath.slice(key.length - 1)))
  }
  throw new Error(`Unexported workspace import: ${specifier}`)
}

const resolveEdge = (
  file: string,
  specifier: string,
  owner: Workspace | undefined,
  workspaces: ReadonlyMap<string, Workspace>,
) => {
  const target = workspaces.get(packageName(specifier))
  if (target !== undefined) {
    if (owner !== undefined) {
      checkDirection(owner.manifest.name, target.manifest.name)
      if (owner !== target && owner.manifest.dependencies?.[target.manifest.name] !== 'workspace:*')
        throw new Error(`Undeclared workspace dependency in ${file}: ${specifier}`)
    }
    return resolveWorkspace(target, specifier)
  }
  if (specifier.startsWith('@sidequest/')) throw new Error(`Unknown workspace import in ${file}: ${specifier}`)
  if (!specifier.startsWith('.')) return undefined
  const destination = posix.normalize(posix.join(dirname(file), specifier))
  if (owner !== undefined && !destination.startsWith(`${owner.directory}/`))
    throw new Error(`Cross-package relative import: ${file} -> ${specifier}`)
  if (file.includes('/src/') && /\/test\//.test(destination)) throw new Error(`Test fixture imported by ${file}`)
  return destination
}

// Local source imports must resolve to audited files. Otherwise an extensionless
// barrel or a JavaScript bridge could hide a server adapter from traversal.
const sourceExtensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']
const sourceSubstitutions: Readonly<Record<string, readonly string[]>> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
}
const resolveSource = (target: string, files: ReadonlySet<string>) => {
  if (files.has(target)) return target
  const extension = posix.extname(target)
  if (extension !== '' && !sourceExtensions.includes(extension)) {
    if (target.includes('?') || target.includes('#')) throw new Error(`Unsupported source import: ${target}`)
    return undefined
  }
  const candidates =
    extension === ''
      ? sourceExtensions.flatMap((suffix) => [`${target}${suffix}`, `${target}/index${suffix}`])
      : (sourceSubstitutions[extension] ?? []).map((suffix) => `${target.slice(0, -extension.length)}${suffix}`)
  const matches = candidates.filter((candidate) => files.has(candidate))
  if (matches.length > 1) throw new Error(`Ambiguous source import: ${target}; use an explicit source extension`)
  const resolved = matches[0]
  if (resolved === undefined) throw new Error(`Unresolved source import: ${target}`)
  return resolved
}

export const checkGraph = async (root = '.') => {
  const files = await sourceFiles(root)
  const fileSet = new Set(files)
  const workspaces: Workspace[] = []
  const dirs = new Set(
    files.filter((file) => /^(apps|packages)\//.test(file)).map((file) => file.split('/').slice(0, 2).join('/')),
  )
  for (const directory of dirs)
    workspaces.push({
      directory,
      manifest: Schema.decodeUnknownSync(Schema.fromJsonString(Manifest))(
        await readFile(posix.join(root, directory, 'package.json'), 'utf8'),
      ),
    })
  const byName = new Map(workspaces.map((workspace) => [workspace.manifest.name, workspace]))
  const edges = new Map<string, string[]>()
  const imports = new Map<string, string[]>()
  for (const file of files) {
    const owner = workspaces.find(({ directory }) => file.startsWith(`${directory}/`))
    const requests = importsOf(file, await readFile(posix.join(root, file), 'utf8'))
    imports.set(file, requests)
    edges.set(
      file,
      requests.flatMap((specifier) => {
        const target = resolveEdge(file, specifier, owner, byName)
        const source = target === undefined ? undefined : resolveSource(target, fileSet)
        return source === undefined ? [] : [source]
      }),
    )
  }
  const visited = new Set<string>()
  const visitBrowser = (file: string) => {
    if (visited.has(file)) return
    visited.add(file)
    const requests = imports.get(file)
    if (requests === undefined) throw new Error(`Unresolved browser source ${file}`)
    assertBrowserSafe(file, '')
    for (const specifier of requests) assertBrowserSafe(file, specifier)
    for (const target of edges.get(file) ?? []) visitBrowser(target)
  }
  visitBrowser('apps/web/src/entry.ts')
  return { files: files.length, browserModules: visited.size }
}
