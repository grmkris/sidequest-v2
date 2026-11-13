import { it } from '@effect/vitest'
import { Option } from 'effect'
import { describe, expect, test } from 'vitest'
import { jobIdWord, jobOfWord, roomIdOf } from '../src/DerivedIds.ts'
import { EventId } from '../src/Event.ts'
import { PublicKey } from '../src/Keys.ts'
import { Hex32 } from './fixtures.ts'

const job = EventId.make('11'.repeat(32))
const buyer = PublicKey.make('22'.repeat(32))
const bidder = PublicKey.make('33'.repeat(32))

describe('ids derived from events', () => {
  // Expected values from Python: sha256(b'sidequest/room/v1\x00' + bytes.fromhex(job + buyer + bidder)).
  test('a room is the hash of its job, its buyer and its bidder, in that order', () => {
    expect(roomIdOf(job, buyer, bidder)).toBe('da58a492bc38774a4a858415d79c87c1f50ccbca9b2d52f35f955885ee7011fc')
    expect(roomIdOf(job, bidder, buyer)).toBe('24c60685dbc43e12aaebc25daedf00d38384cfa80f09254ab4fade6465e79bc7')
  })

  it.prop('a job’s contract word is its request event id, and reads back to it', [Hex32], ([hex]) => {
    const id = EventId.make(hex)
    return jobIdWord(id) === `0x${hex}` && Option.contains(jobOfWord(jobIdWord(id)), id)
  })

  test('a word that is not 0x and 64 lowercase hex characters names no job', () => {
    expect(jobOfWord('11'.repeat(32))).toEqual(Option.none())
    expect(jobOfWord(`0x${'AB'.repeat(32)}`)).toEqual(Option.none())
    expect(jobOfWord(`0x${'ab'.repeat(31)}`)).toEqual(Option.none())
  })
})
