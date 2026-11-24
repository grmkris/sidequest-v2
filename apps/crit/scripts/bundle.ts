/** A page folder as the files a publish sends: every file under it, with its type by extension. */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { contentTypeOf } from '../src/ContentType.ts'
import type { PageFile } from './guards.ts'

/** Folders a page never means to publish, and the Finder's droppings. Everything else is read, so the guards see it. */
const skipped = new Set(['node_modules', '.DS_Store'])

const walk = (folder: string, prefix: string): ReadonlyArray<string> =>
  readdirSync(folder, { withFileTypes: true })
    .filter((entry) => !skipped.has(entry.name))
    .flatMap((entry) => {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) return walk(join(folder, entry.name), path)
      return entry.isFile() ? [path] : []
    })

export const filesOf = (folder: string): ReadonlyArray<PageFile> =>
  walk(folder, '')
    .toSorted()
    .map((path) => ({
      path,
      bytes: new Uint8Array(readFileSync(join(folder, path))),
      contentType: contentTypeOf(path),
    }))
