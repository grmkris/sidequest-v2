/**
 * Upstream repositories vendored under `repos/` as read-only references for agents
 * (the `foldkit` skill expects `repos/foldkit/`). Each snapshot is pinned to one
 * upstream commit and verified by a tree hash in `repos/sources.json`. A snapshot of
 * an installed package must match its catalog version, and skills vendored from the
 * same repository must share its commit. Upstream agent instructions are excluded or
 * renamed so no agent loads another project's rules as this repository's. Files an
 * upstream ships for its consumers (Foldkit's `FOLDKIT.md`) are copied out verbatim,
 * refreshed on pull and verified against the snapshot.
 *
 *   bun tools/vendored-repos.ts                     verify every snapshot (part of `bun run check`)
 *   bun tools/vendored-repos.ts --pull <name> <ref> replace a snapshot with the given tag or commit
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, lstat, mkdtemp, readFile, readlink, readdir, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Schema } from 'effect'

const Snapshot = Schema.Struct({
  repository: Schema.String,
  ref: Schema.String,
  commit: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)),
  license: Schema.String,
  exclude: Schema.Array(Schema.String),
  /** Upstream-relative paths moved after extraction, e.g. agent instructions agents would auto-load. */
  rename: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  /** Snapshot files kept verbatim in the repository: repository path → snapshot-relative path. */
  copies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  /** Catalog package this snapshot documents; `ref` must be `<package>@<catalog version>`. */
  package: Schema.optional(Schema.String),
  treeSha256: Schema.String,
})
const Manifest = Schema.Record(Schema.String, Snapshot)
type Manifest = typeof Manifest.Type
const Commit = Schema.Struct({ sha: Schema.String })
const Catalog = Schema.Struct({ workspaces: Schema.Struct({ catalog: Schema.Record(Schema.String, Schema.String) }) })
const Skills = Schema.Struct({
  skills: Schema.Record(Schema.String, Schema.Struct({ repository: Schema.String, commit: Schema.String })),
})

const root = path.resolve(import.meta.dir, '..')
const manifestPath = path.join(root, 'repos/sources.json')

const readManifest = async (): Promise<Manifest> =>
  Schema.decodeUnknownSync(Schema.fromJsonString(Manifest))(await readFile(manifestPath, 'utf8'))

/** sha256 over sorted `<file sha256>  <relative path>` lines; symlinks hash their target. */
const treeSha256 = async (directory: string): Promise<{ readonly files: number; readonly sha256: string }> => {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true })
  const lines: string[] = []
  for (const entry of entries) {
    if (entry.isDirectory()) continue
    const absolute = path.join(entry.parentPath, entry.name)
    const relative = path.relative(directory, absolute)
    const content = (await lstat(absolute)).isSymbolicLink() ? await readlink(absolute) : await readFile(absolute)
    lines.push(`${createHash('sha256').update(content).digest('hex')}  ${relative}\n`)
  }
  lines.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
  return { files: lines.length, sha256: createHash('sha256').update(lines.join('')).digest('hex') }
}

const run = (command: string, args: ReadonlyArray<string>, cwd = root) => {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr.trim()}`)
  return result.stdout
}

/** Every directory under `repos/` must be a recorded snapshot. */
const assertRecorded = async (manifest: Manifest) => {
  for (const entry of await readdir(path.join(root, 'repos'), { withFileTypes: true })) {
    if (entry.isDirectory() && manifest[entry.name] === undefined) {
      throw new Error(`repos/${entry.name} has no entry in repos/sources.json; vendor it with --pull`)
    }
  }
}

/** A package snapshot follows the installed version, and its repository's skills share its commit. */
const assertPinned = (
  name: string,
  snapshot: Manifest[string],
  catalog: Readonly<Record<string, string>>,
  skills: (typeof Skills.Type)['skills'],
) => {
  const expected = snapshot.package === undefined ? snapshot.ref : `${snapshot.package}@${catalog[snapshot.package]}`
  if (snapshot.ref !== expected) {
    throw new Error(`repos/${name} is ${snapshot.ref} but the catalog installs ${expected}; re-pull it`)
  }
  for (const [skill, source] of Object.entries(skills)) {
    if (source.repository === snapshot.repository && source.commit !== snapshot.commit) {
      throw new Error(`Skill ${skill} is pinned to ${source.commit}, repos/${name} to ${snapshot.commit}; update both`)
    }
  }
}

/** Each copied file is byte-identical to its source in the snapshot. */
const assertCopied = async (name: string, snapshot: Manifest[string]) => {
  for (const [target, source] of Object.entries(snapshot.copies ?? {})) {
    const [copy, original] = await Promise.all([
      readFile(path.join(root, target)),
      readFile(path.join(root, 'repos', name, source)),
    ])
    if (!copy.equals(original)) {
      throw new Error(`${target} differs from repos/${name}/${source}; re-pull the snapshot, never edit the copy`)
    }
  }
}

const verify = async () => {
  const manifest = await readManifest()
  const catalog = Schema.decodeUnknownSync(Schema.fromJsonString(Catalog))(
    await readFile(path.join(root, 'package.json'), 'utf8'),
  ).workspaces.catalog
  const skills = Schema.decodeUnknownSync(Schema.fromJsonString(Skills))(
    await readFile(path.join(root, '.agents/skills/sources.json'), 'utf8'),
  ).skills
  await assertRecorded(manifest)
  for (const [name, snapshot] of Object.entries(manifest)) {
    assertPinned(name, snapshot, catalog, skills)
    const actual = await treeSha256(path.join(root, 'repos', name))
    if (actual.sha256 !== snapshot.treeSha256) {
      throw new Error(`repos/${name} differs from ${snapshot.repository}@${snapshot.commit}; re-pull it, never edit it`)
    }
    await assertCopied(name, snapshot)
    console.log(`Verified repos/${name} (${actual.files} files) at ${snapshot.repository}@${snapshot.ref}`)
  }
}

const pull = async (name: string, ref: string) => {
  const manifest = await readManifest()
  const current = manifest[name]
  if (current === undefined) throw new Error(`repos/sources.json has no entry for ${name}`)
  const response = await fetch(`https://api.github.com/repos/${current.repository}/commits/${encodeURIComponent(ref)}`)
  if (!response.ok) throw new Error(`Cannot resolve ${current.repository}@${ref}: HTTP ${response.status}`)
  const { sha: commit } = Schema.decodeUnknownSync(Commit)(await response.json())

  // The archive is untrusted data: download and extract it in a fresh directory, never execute it.
  const scratch = await mkdtemp(path.join(os.tmpdir(), `sidequest-vendor-${name}-`))
  try {
    const archive = path.join(scratch, 'source.tar.gz')
    const tarball = await fetch(`https://codeload.github.com/${current.repository}/tar.gz/${commit}`)
    if (!tarball.ok) throw new Error(`Cannot download ${current.repository}@${commit}: HTTP ${tarball.status}`)
    await writeFile(archive, new Uint8Array(await tarball.arrayBuffer()))
    const extracted = path.join(scratch, 'tree')
    run('mkdir', [extracted])
    run('tar', ['-xzf', archive, '-C', extracted, '--strip-components=1'])
    // Exclusions and renames are paths relative to the upstream root, not name patterns.
    for (const excluded of current.exclude) await rm(path.join(extracted, excluded), { recursive: true, force: true })
    for (const [from, to] of Object.entries(current.rename ?? {})) {
      await rename(path.join(extracted, from), path.join(extracted, to))
    }
    const target = path.join(root, 'repos', name)
    await rm(target, { recursive: true, force: true })
    await cp(extracted, target, { recursive: true, verbatimSymlinks: true })
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }

  const ignored = run('git', ['ls-files', '--others', '--ignored', '--exclude-standard', '--', `repos/${name}`]).trim()
  if (ignored !== '') throw new Error(`Git would drop vendored files; extend "exclude" instead:\n${ignored}`)
  for (const [target, source] of Object.entries(current.copies ?? {})) {
    await cp(path.join(root, 'repos', name, source), path.join(root, target))
  }
  const tree = await treeSha256(path.join(root, 'repos', name))
  const next: Manifest = { ...manifest, [name]: { ...current, ref, commit, treeSha256: tree.sha256 } }
  await writeFile(manifestPath, `${JSON.stringify(next, null, 2)}\n`)
  console.log(`Pulled repos/${name} (${tree.files} files) at ${current.repository}@${ref} (${commit})`)
}

const [mode, name, ref] = process.argv.slice(2)
if (mode === undefined) await verify()
else if (mode === '--pull' && name !== undefined && ref !== undefined) await pull(name, ref)
else throw new Error('Usage: bun tools/vendored-repos.ts [--pull <name> <ref>]')
