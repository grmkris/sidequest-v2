import { it } from '@effect/vitest'
import { Effect } from 'effect'
import { createHash } from 'node:crypto'
import { describe, expect } from 'vitest'
import { deliveryHashOf } from '../src/DeliveryNote.ts'
import { job } from './jobFixtures.ts'

const sha256 = (text: string) => `0x${createHash('sha256').update(text, 'utf8').digest('hex')}`

describe('a delivery hash', () => {
  it.effect('is the SHA-256 of the canonical JSON of the job, the note and the address, keys sorted', () =>
    Effect.gen(function* () {
      const url = 'https://files.example/logo.svg'
      const note = 'The SVG and a PNG at 2048 px, «finale» ✓'
      expect(yield* deliveryHashOf({ job, url, note })).toBe(sha256(`{"job":"${job}","note":"${note}","url":"${url}"}`))
      expect(yield* deliveryHashOf({ job, url })).toBe(sha256(`{"job":"${job}","url":"${url}"}`))
      expect(yield* deliveryHashOf({ job, note })).toBe(sha256(`{"job":"${job}","note":"${note}"}`))
    }),
  )

  it.effect('escapes as JSON does, so a quote in a note cannot forge another member', () =>
    Effect.gen(function* () {
      const forged = yield* deliveryHashOf({ job, note: 'a","url":"https://evil.example' })
      expect(forged).not.toBe(yield* deliveryHashOf({ job, note: 'a', url: 'https://evil.example' }))
      expect(forged).toMatch(/^0x[0-9a-f]{64}$/u)
    }),
  )
})
