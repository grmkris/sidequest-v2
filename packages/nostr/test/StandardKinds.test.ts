import { Option, Result, Schema } from 'effect'
import { describe, expect, test } from 'vitest'
import type { EventTemplate } from '../src/Event.ts'
import { publicKeyOf } from '../src/Keys.ts'
import { parseProfileName, profileTemplate } from '../src/Profile.ts'
import {
  messagingRelaysTemplate,
  parseMessagingRelays,
  parseRelayList,
  RelayUrl,
  relayListTemplate,
} from '../src/RelayList.ts'
import { finalizeEvent } from '../src/Sign.ts'
import { alice, zeros } from './fixtures.ts'

const sign = (template: EventTemplate) => finalizeEvent(template, alice, zeros)
const relay = Schema.decodeSync(RelayUrl)

const reason = (input: unknown) =>
  Result.match(parseProfileName(input), { onSuccess: () => 'accepted', onFailure: (error) => error.reason })

describe('profiles', () => {
  test('reads the names someone chose, and drops one that is not a name', () => {
    const content = JSON.stringify({ name: 'alice', display_name: '  ', about: 'hi', picture: 'https://x' })
    const profile = Result.getOrUndefined(parseProfileName(sign({ created_at: 1, kind: 0, tags: [], content })))
    expect(profile).toEqual({ pubkey: publicKeyOf(alice), name: Option.some('alice'), displayName: Option.none() })
  })

  test('writes a profile with a name that reads back', () => {
    const parsed = Result.getOrUndefined(parseProfileName(sign(profileTemplate('Alice Č', 1))))
    expect(parsed?.name).toEqual(Option.some('Alice Č'))
  })

  test('refuses a profile that is not JSON, of another kind, or unsigned', () => {
    expect(reason(sign({ created_at: 1, kind: 0, tags: [], content: 'alice' }))).toBe('badContent')
    expect(reason(sign({ ...profileTemplate('alice', 1), kind: 1 }))).toBe('wrongKind')
    expect(reason({ ...sign(profileTemplate('alice', 1)), content: '{"name":"mallory"}' })).toBe('invalidEvent')
  })
})

describe('relay lists', () => {
  const both = relay('wss://relay.example')
  const readOnly = relay('wss://read.example')
  const writeOnly = relay('ws://write.example:7777/nostr')

  test('reads NIP-65 markers, an unmarked relay being both, and skips what is not a relay', () => {
    const event = sign({
      created_at: 1,
      kind: 10_002,
      tags: [
        ['r', both],
        ['r', readOnly, 'read'],
        ['r', writeOnly, 'write'],
        ['r', 'https://not.a.relay'],
        ['p', 'x'],
      ],
      content: '',
    })
    expect(Result.getOrUndefined(parseRelayList(event))).toEqual({
      pubkey: publicKeyOf(alice),
      read: [both, readOnly],
      write: [both, writeOnly],
    })
  })

  test('writes a list that reads back, marking only relays that are not both', () => {
    const template = relayListTemplate({ read: [both, readOnly], write: [both, writeOnly] }, 1)
    expect(template.tags).toEqual([
      ['r', both],
      ['r', readOnly, 'read'],
      ['r', writeOnly, 'write'],
    ])
    expect(Result.getOrUndefined(parseRelayList(sign(template)))?.read).toEqual([both, readOnly])
  })

  test('reads and writes NIP-17 messaging relays', () => {
    const parsed = Result.getOrUndefined(parseMessagingRelays(sign(messagingRelaysTemplate([both, readOnly], 1))))
    expect(parsed?.relays).toEqual([both, readOnly])
    expect(Result.isFailure(parseMessagingRelays(sign(relayListTemplate({ read: [both], write: [] }, 1))))).toBe(true)
  })
})
