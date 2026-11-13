import { describe, expect, test } from 'vitest'
import { foldJob } from '../src/FoldJob.ts'
import type { JobInput } from '../src/JobInput.ts'
import { grantStories } from './grantStories.ts'
import { stories } from './stories.ts'

/** mulberry32: a tiny seeded generator, so a failing seed reproduces. */
const generator = (seed: number) => {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296
  }
}

/** The items, each repeated with probability one half, shuffled by sorting on random keys. */
const scramble = <A>(items: ReadonlyArray<A>, random: () => number): ReadonlyArray<A> =>
  items
    .flatMap((item) => (random() < 0.5 ? [item, item] : [item]))
    .map((item) => ({ key: random(), item }))
    .toSorted((left, right) => left.key - right.key)
    .map(({ item }) => item)

const scrambled = (input: JobInput, seed: number): JobInput => {
  const random = generator(seed)
  return {
    ...input,
    events: scramble(input.events, random),
    chain: scramble(input.chain, random),
    walletLinks: scramble(input.walletLinks, random),
    grants: scramble(input.grants, random),
  }
}

const seeds = Array.from({ length: 40 }, (_, index) => index * 7_919 + 1)

describe('the fold ignores the order and repetition of its inputs', () => {
  test.each(Object.entries({ ...stories, ...grantStories }))('%s', (_, input) => {
    const view = foldJob(input)
    for (const seed of seeds) expect(foldJob(scrambled(input, seed)), `seed ${seed}`).toEqual(view)
  })
})
