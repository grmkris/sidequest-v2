import { OpenJob as IndexOpenJob } from '@sidequest/fold/api'
import { Option, Schema } from 'effect'
import { describe, expect, test } from 'vitest'
import { OpenJob } from '../src/OpenJob.ts'
import { buyerKey, now, requestId } from './Fixtures.ts'

describe('the website’s open request', () => {
  test('is the index’s: the same answer decodes the same, both ways, and the types are one', () => {
    const answered = {
      job: requestId,
      buyer: buyerKey,
      createdAt: now,
      request: { title: 'A logo', description: 'Warm colours.', expiresAt: now + 86_400 },
      expired: false,
      proposals: 2,
    }
    const fromIndex: IndexOpenJob = Schema.decodeUnknownSync(IndexOpenJob)(answered)
    const here: OpenJob = Schema.decodeUnknownSync(OpenJob)(answered)
    expect(here).toEqual(fromIndex)
    const backHere: IndexOpenJob = here
    const backThere: OpenJob = fromIndex
    expect(Schema.encodeSync(OpenJob)(backThere)).toEqual(Schema.encodeSync(IndexOpenJob)(backHere))
    expect(Object.keys(OpenJob.fields).toSorted()).toEqual(Object.keys(IndexOpenJob.fields).toSorted())
    expect(Schema.decodeUnknownOption(OpenJob)({ ...answered, proposals: 'two' })).toEqual(Option.none())
  })
})
