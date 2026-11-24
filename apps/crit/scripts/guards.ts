/**
 * Checks before anything leaves the machine: files that must never be published, secrets inside text files, and
 * sizes. Every problem is reported, and any problem stops the publish. The rules are src/Guards.ts's, which the
 * Workers apply again.
 */
import { deniedPath, flagsOf } from '../src/Guards.ts'
import { maxFileBytes, maxFiles, maxPageBytes } from '../src/Model.ts'

export interface PageFile {
  readonly path: string
  readonly bytes: Uint8Array<ArrayBuffer>
  readonly contentType: string
}

export interface CheckOptions {
  /** The person said to publish although a file looks like it holds a secret (`publish --allow-secrets`). */
  readonly allowSecrets: boolean
}

const fileProblems = (file: PageFile, options: CheckOptions): ReadonlyArray<string> => [
  ...(deniedPath(file.path) ? [`${file.path}: this kind of file is never published`] : []),
  ...(file.bytes.byteLength > maxFileBytes ? [`${file.path}: larger than 25 MiB`] : []),
  ...(options.allowSecrets ? [] : flagsOf(file.bytes).map((name) => `${file.path}: looks like it holds a ${name}`)),
]

export const check = (
  files: ReadonlyArray<PageFile>,
  options: CheckOptions = { allowSecrets: false },
): ReadonlyArray<string> => {
  const total = files.reduce((sum, file) => sum + file.bytes.byteLength, 0)
  return [
    ...(files.length === 0 ? ['the page folder is empty'] : []),
    ...(files.length > maxFiles ? [`the page has ${files.length} files; the limit is ${maxFiles}`] : []),
    ...files.flatMap((file) => fileProblems(file, options)),
    ...(total > maxPageBytes ? ['the page is larger than 500 MiB'] : []),
  ]
}
