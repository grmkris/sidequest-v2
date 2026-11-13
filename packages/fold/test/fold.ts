import { Option } from 'effect'
import { expect } from 'vitest'
import { foldJob } from '../src/FoldJob.ts'
import type { JobInput } from '../src/JobInput.ts'
import type { JobView } from '../src/JobView.ts'

/** Folds a story whose request is present; a story without one fails here. */
export const fold = (input: JobInput): JobView => {
  const view = foldJob(input)
  expect(Option.isSome(view)).toBe(true)
  return Option.getOrThrow(view)
}
