import { it } from '@effect/vitest'
import { Result, Schema } from 'effect'
import { describe, expect, test } from 'vitest'
import { httpAuthHeader, httpAuthTemplate, verifyHttpAuth } from '../src/HttpAuth.ts'
import { publicKeyOf } from '../src/Keys.ts'
import { finalizeEvent } from '../src/Sign.ts'
import { alice, GeneratedSecret, Hex32, secret, zeros } from './fixtures.ts'

const signedAt = 1_800_000_000
const request = { url: 'https://sidequest.example/api/jobs?mine=1', method: 'POST', payloadSha256: 'ab'.repeat(32) }
const header = (facts = request, createdAt = signedAt, key = alice) =>
  httpAuthHeader(finalizeEvent(httpAuthTemplate(facts, createdAt), key, zeros))
const outcome = (value: string, facts: Parameters<typeof verifyHttpAuth>[1] = request, now = signedAt) =>
  Result.match(verifyHttpAuth(value, facts, now, 60), { onSuccess: (key) => key, onFailure: (error) => error.reason })

// The Authorization header in NIP-98 (nostr-protocol/nips@1fb3a95f, 98.md) carries its example event.
const specHeader =
  'Nostr eyJpZCI6ImZlOTY0ZTc1ODkwMzM2MGYyOGQ4NDI0ZDA5MmRhODQ5NGVkMjA3Y2JhODIzMTEwYmUzYTU3ZGZlNGI1Nzg3MzQiLCJwdWJrZXkiOiI2M2ZlNjMxOGRjNTg1ODNjZmUxNjgxMGY4NmRkMDllMThiZmQ3NmFhYmMyNGEwMDgxY2UyODU2ZjMzMDUwNGVkIiwiY29udGVudCI6IiIsImtpbmQiOjI3MjM1LCJjcmVhdGVkX2F0IjoxNjgyMzI3ODUyLCJ0YWdzIjpbWyJ1IiwiaHR0cHM6Ly9hcGkuc25vcnQuc29jaWFsL2FwaS92MS9uNXNwL2xpc3QiXSxbIm1ldGhvZCIsIkdFVCJdXSwic2lnIjoiNWVkOWQ4ZWM5NThiYzg1NGY5OTdiZGMyNGFjMzM3ZDAwNWFmMzcyMzI0NzQ3ZWZlNGEwMGUyNGY0YzMwNDM3ZmY0ZGQ4MzA4Njg0YmVkNDY3ZDlkNmJlM2U1YTUxN2JiNDNiMTczMmNjN2QzMzk0OWEzYWFmODY3MDVjMjIxODQifQ'

describe('NIP-98 HTTP auth', () => {
  it.prop(
    'names the signer of a fresh authorization for exactly this request',
    [GeneratedSecret, Schema.Int.check(Schema.isBetween({ minimum: -60, maximum: 60 })), Hex32],
    ([key, skew, payload]) => {
      const facts = { ...request, payloadSha256: payload }
      return outcome(header(facts, signedAt, secret(key)), facts, signedAt + skew) === publicKeyOf(secret(key))
    },
  )

  test('refuses an authorization outside the window, or for another URL, method or body', () => {
    expect(outcome(header(), request, signedAt + 61)).toBe('stale')
    expect(outcome(header(), request, signedAt - 61)).toBe('stale')
    expect(outcome(header(), { ...request, url: 'https://sidequest.example/api/jobs' })).toBe('urlMismatch')
    expect(outcome(header(), { ...request, method: 'PUT' })).toBe('methodMismatch')
    expect(outcome(header(), { ...request, payloadSha256: 'cd'.repeat(32) })).toBe('payloadMismatch')
    expect(outcome(header(), { url: request.url, method: request.method })).toBe('payloadMismatch')
  })

  test('refuses a header that is not a signed kind-27235 event', () => {
    expect(outcome('Bearer abc')).toBe('malformedHeader')
    expect(outcome('Nostr !!!')).toBe('malformedHeader')
    expect(outcome('Nostr bm90IGpzb24=')).toBe('malformedHeader')
    expect(outcome(header().replace(/.{4}$/u, 'AAAA'))).not.toBe(publicKeyOf(alice))
    const note = httpAuthHeader(finalizeEvent({ ...httpAuthTemplate(request, signedAt), kind: 1 }, alice, zeros))
    expect(outcome(note)).toBe('wrongKind')
    // The spec's example event does not hash to its id.
    expect(outcome(specHeader, { url: 'https://api.snort.social/api/v1/n5sp/list', method: 'GET' }, 1682327852)).toBe(
      'invalidEvent',
    )
  })
})
