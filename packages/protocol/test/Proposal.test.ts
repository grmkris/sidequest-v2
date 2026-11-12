import { Option, Schema } from 'effect'
import { describe, expect, test } from 'vitest'
import { Proposal } from '../src/Proposal.ts'
import { accountId, digest, encodedTerms, jobId, proposalId } from './fixtures.ts'

const accepts = (version: unknown, previous?: unknown) =>
  Option.isSome(
    Schema.decodeUnknownOption(Proposal)({
      id: proposalId,
      job: jobId,
      bidder: accountId,
      version,
      ...(previous === undefined ? {} : { previous }),
      terms: encodedTerms,
      termsDigest: digest,
    }),
  )

describe('Proposal versions', () => {
  test.each([
    ['version 1 with no previous', 1, undefined, true],
    ['version 2 after 1', 2, 1, true],
    ['version 7 after 6', 7, 6, true],
    ['version 1 naming a previous', 1, 0, false],
    ['version 2 with no previous', 2, undefined, false],
    ['a skipped version', 3, 1, false],
    ['a repeated version', 2, 2, false],
    ['version 0', 0, undefined, false],
    ['a fractional version', 1.5, undefined, false],
  ])('%s is accepted: %s', (_name, version, previous, expected) => {
    expect(accepts(version, previous)).toBe(expected)
  })
})
