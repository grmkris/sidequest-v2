import { Option } from 'effect'
import { describe, expect, test } from 'vitest'
import { passkeyRpIdFor } from '../src/server/StageSettings.ts'

// Which relying party ID a page offers passkeys for (ADR-0005): the stage's, only on a hostname WebAuthn lets use it.

describe('the passkeys’ relying party on a page', () => {
  test('is the stage’s on its own hostname and its subdomains, and none elsewhere or unset', () => {
    const setting = Option.some('sidequest.exchange')
    expect(passkeyRpIdFor(setting, 'v2.sidequest.exchange')).toEqual(setting)
    expect(passkeyRpIdFor(setting, 'sidequest.exchange')).toEqual(setting)
    expect(passkeyRpIdFor(Option.some(' Sidequest.Exchange '), 'v2.sidequest.exchange')).toEqual(setting)
    expect(passkeyRpIdFor(setting, 'edge.example.workers.dev')).toEqual(Option.none())
    expect(passkeyRpIdFor(setting, 'evilsidequest.exchange')).toEqual(Option.none())
    expect(passkeyRpIdFor(setting, 'sidequest.exchange.example')).toEqual(Option.none())
    expect(passkeyRpIdFor(Option.some(''), 'sidequest.exchange')).toEqual(Option.none())
    expect(passkeyRpIdFor(Option.none(), 'v2.sidequest.exchange')).toEqual(Option.none())
    expect(passkeyRpIdFor(Option.some('localhost'), 'localhost')).toEqual(Option.some('localhost'))
  })
})
