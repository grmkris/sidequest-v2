import { Result } from 'effect'
import { describe, expect, test } from 'vitest'
import { defaultTiming } from '../src/Index/IndexConfig.ts'
import { eventLimits } from '../src/Index/Validation.ts'
import { admit, admissionLimits, makeAdmissions } from '../src/RelayPipe/PipeAdmission.ts'
import {
  dialUrlOf,
  forwardedClose,
  openedPipe,
  type PipeEvent,
  type PipeState,
  pipeLimits,
  pipeStep,
  pipeTargetOf,
  type Step,
  utf8Length,
} from '../src/RelayPipe/PipePolicy.ts'

const site = 'https://sidequest.example.com'

/** An upgrade request to the pipe from `origin`, asking for `relay`. */
const upgrade = (relay: string | ReadonlyArray<string>, headers: Record<string, string> = {}, method = 'GET') => {
  const url = new URL('/relay', site)
  for (const asked of typeof relay === 'string' ? [relay] : relay) url.searchParams.append('url', asked)
  const all = new Headers({ upgrade: 'websocket', origin: site, ...headers })
  return { method, url: url.href, headers: all }
}

const refusalOf = (request: ReturnType<typeof upgrade>, policy: 'public' | 'local' = 'public') => {
  const target = pipeTargetOf(request, policy)
  return Result.isFailure(target) ? target.failure : undefined
}

describe('an upgrade request to the relay pipe', () => {
  test('is served from this origin for a public relay, and names the relay and its host', () => {
    expect(pipeTargetOf(upgrade('wss://Relay.Damus.io'), 'public')).toEqual(
      Result.succeed({ relay: 'wss://relay.damus.io/', host: 'relay.damus.io' }),
    )
    expect(pipeTargetOf(upgrade('ws://127.0.0.1:4848', { upgrade: 'WebSocket' }), 'local')).toEqual(
      Result.succeed({ relay: 'ws://127.0.0.1:4848/', host: '127.0.0.1' }),
    )
  })

  test('is refused with 405 for another method and 426 without a WebSocket upgrade', () => {
    expect(refusalOf(upgrade('wss://nos.lol', {}, 'POST'))).toEqual({ status: 405, reason: 'method' })
    expect(refusalOf(upgrade('wss://nos.lol', { upgrade: 'h2c' }))).toEqual({ status: 426, reason: 'upgrade' })
  })

  test('is refused with 403 from another origin, a sibling, another scheme or port, an opaque origin, or none', () => {
    for (const origin of [
      'https://evil.example',
      'https://app.sidequest.example.com',
      'http://sidequest.example.com',
      'https://sidequest.example.com:8443',
      'null',
    ])
      expect(refusalOf(upgrade('wss://nos.lol', { origin }))).toEqual({ status: 403, reason: 'origin' })
    const request = upgrade('wss://nos.lol')
    request.headers.delete('origin')
    expect(refusalOf(request)).toEqual({ status: 403, reason: 'origin' })
  })

  test('is refused with 400 for a relay the policy does not allow, no relay, two, or this site itself', () => {
    for (const relay of [
      'ws://relay.damus.io',
      'wss://relay.damus.io:8443',
      'wss://10.0.0.8',
      'wss://localhost',
      'wss://user:pass@relay.damus.io',
      'https://relay.damus.io',
      'ws://127.0.0.1:4848',
      'wss://sidequest.example.com',
      '',
    ])
      expect(refusalOf(upgrade(relay))).toEqual({ status: 400, reason: 'url' })
    expect(refusalOf(upgrade([]))).toEqual({ status: 400, reason: 'url' })
    expect(refusalOf(upgrade(['wss://nos.lol', 'wss://relay.damus.io']))).toEqual({ status: 400, reason: 'url' })
    expect(refusalOf(upgrade('ws://10.0.0.8:4848'), 'local')).toEqual({ status: 400, reason: 'url' })
  })

  test('dials the relay over the scheme fetch speaks', () => {
    expect(dialUrlOf('wss://relay.damus.io/')).toBe('https://relay.damus.io/')
    expect(dialUrlOf('ws://127.0.0.1:4848/')).toBe('http://127.0.0.1:4848/')
  })
})

const limits = { ...pipeLimits, clientBurst: 3, clientPerSecond: 1, clientFrameLength: 10, relayFrameLength: 20 }
const opened = openedPipe(0, limits)

/** Steps through `events`, one per millisecond from `start`, and answers each step. */
const run = (events: ReadonlyArray<PipeEvent>, start = 0, from: PipeState = opened) =>
  events.reduce<ReadonlyArray<Step>>((steps, event, index) => {
    const state = steps.at(-1)?.state ?? from
    return [...steps, pipeStep(state, event, start + index, limits)]
  }, [])

const endOf = (step: Step | undefined) => (step !== undefined && 'end' in step ? step.end : undefined)

describe('the frame policy', () => {
  test('forwards text within the caps to the other side, counting frames and UTF-8 bytes each way', () => {
    const steps = run([
      { from: 'client', message: '["REQ"]' },
      { from: 'relay', message: '["EOSE","é"]' },
    ])
    expect(steps.map((step) => ('forward' in step ? step.forward : undefined))).toEqual([
      { to: 'relay', text: '["REQ"]' },
      { to: 'client', text: '["EOSE","é"]' },
    ])
    expect(steps.at(-1)?.state.traffic).toEqual({
      framesToRelay: 1,
      bytesToRelay: 7,
      framesToClient: 1,
      bytesToClient: 13,
    })
  })

  test('ends the pipe with 1009 for a message over its side cap, and allows one at the cap', () => {
    expect('forward' in pipeStep(opened, { from: 'client', message: 'x'.repeat(10) }, 0, limits)).toBe(true)
    expect(endOf(pipeStep(opened, { from: 'client', message: 'x'.repeat(11) }, 0, limits))).toEqual({
      client: { code: 1009, reason: '' },
      relay: { code: 1009, reason: '' },
      reason: 'clientFrameTooLarge',
    })
    expect('forward' in pipeStep(opened, { from: 'relay', message: 'x'.repeat(20) }, 0, limits)).toBe(true)
    expect(endOf(pipeStep(opened, { from: 'relay', message: 'x'.repeat(21) }, 0, limits))?.reason).toBe(
      'relayFrameTooLarge',
    )
  })

  test('ends the pipe with 1003 for a binary message from either side', () => {
    expect(endOf(pipeStep(opened, { from: 'client', message: new ArrayBuffer(1) }, 0, limits))).toMatchObject({
      client: { code: 1003 },
      reason: 'clientBinary',
    })
    expect(endOf(pipeStep(opened, { from: 'relay', message: new Blob(['x']) }, 0, limits))?.reason).toBe('relayBinary')
  })

  test('ends the pipe with 1008 for a client past its burst, and lets it send again once the bucket refills', () => {
    const burst = run(Array.from({ length: 4 }, () => ({ from: 'client', message: 'x' }) as const))
    expect(burst.slice(0, 3).every((step) => 'forward' in step)).toBe(true)
    expect(endOf(burst[3])).toEqual({
      client: { code: 1008, reason: '' },
      relay: { code: 1000, reason: '' },
      reason: 'clientRate',
    })
    const spent = burst[2]?.state ?? opened
    expect('forward' in pipeStep(spent, { from: 'client', message: 'x' }, 1_002, limits)).toBe(true)
    // The relay is never rate-limited: a subscription's stored events arrive as fast as it sends them.
    expect(
      run(Array.from({ length: 10 }, () => ({ from: 'relay', message: 'x' }) as const)).every(
        (step) => 'forward' in step,
      ),
    ).toBe(true)
  })

  test('forwards a close to the other side, keeping codes a frame may carry and mapping the rest', () => {
    expect(endOf(pipeStep(opened, { from: 'client', closed: { code: 4001, reason: 'bye' } }, 0, limits))).toEqual({
      client: { code: 4001, reason: 'bye' },
      relay: { code: 4001, reason: 'bye' },
      reason: 'clientClosed',
    })
    expect(endOf(pipeStep(opened, { from: 'relay', closed: { code: 1006, reason: '' } }, 0, limits))).toEqual({
      client: { code: 1011, reason: '' },
      relay: { code: 1006, reason: '' },
      reason: 'relayClosed',
    })
    expect(forwardedClose({ code: 1005, reason: '' })).toEqual({ code: 1000, reason: '' })
    expect(forwardedClose({ code: 1015, reason: 'tls' })).toEqual({ code: 1011, reason: '' })
    expect(forwardedClose({ code: 1001, reason: 'é'.repeat(100) }).reason).toBe('é'.repeat(61))
  })

  test('closes both sides with 1011 when either errors, and with 1001 when idle', () => {
    expect(endOf(pipeStep(opened, { from: 'relay', error: true }, 0, limits))).toEqual({
      client: { code: 1011, reason: '' },
      relay: { code: 1011, reason: '' },
      reason: 'relayError',
    })
    expect(endOf(pipeStep(opened, { idle: true }, 0, limits))).toMatchObject({ client: { code: 1001 }, reason: 'idle' })
  })

  test('counts UTF-8 bytes as an encoder would, lone surrogates included', () => {
    const encoder = new TextEncoder()
    for (const text of ['', 'ascii', 'é', '€', '😀', 'a😀b', '\ud800', '\ud800x', '\udc00'])
      expect(utf8Length(text)).toBe(encoder.encode(text).length)
  })

  test('caps the client at the largest event the index accepts with its envelope, and the relay as the index reads', () => {
    expect(pipeLimits.clientFrameLength - eventLimits.serializedLength).toBeGreaterThanOrEqual(512)
    expect(pipeLimits.relayFrameLength).toBe(defaultTiming.maxFrameLength)
  })
})

describe('admission to the pipe', () => {
  const small = { ...admissionLimits, openPerAddress: 2, connectBurst: 3, connectsPerSecond: 1, tracked: 2 }

  test('holds an address to its open pipes, and admits again once one is released', () => {
    const admissions = makeAdmissions(small)
    expect([admissions.take('a', 0), admissions.take('a', 0), admissions.take('a', 0)]).toEqual([
      'admitted',
      'admitted',
      'tooManyOpen',
    ])
    expect(admissions.take('b', 0)).toBe('admitted')
    admissions.release('a')
    expect(admissions.openFor('a')).toBe(1)
    expect(admissions.take('a', 0)).toBe('admitted')
  })

  test('holds an address to its connect rate even when every pipe closes at once', () => {
    const admissions = makeAdmissions(small)
    const verdicts = Array.from({ length: 4 }, () => {
      const verdict = admissions.take('a', 0)
      admissions.release('a')
      return verdict
    })
    expect(verdicts).toEqual(['admitted', 'admitted', 'admitted', 'tooFast'])
    expect(admit(undefined, 0, small).verdict).toBe('admitted')
    expect(admissions.take('a', 1_000)).toBe('admitted')
  })

  test('forgets idle addresses first when it tracks too many, never one with an open pipe', () => {
    const admissions = makeAdmissions(small)
    admissions.take('open', 0)
    admissions.take('idle', 0)
    admissions.release('idle')
    admissions.take('new', 0)
    expect(admissions.openFor('open')).toBe(1)
    expect(admissions.openFor('new')).toBe(1)
  })
})
