import { httpAuthHeader, httpAuthTemplate, publicKeyOf, type SecretKey } from '@sidequest/nostr'
import { HiddenTarget, textDigest, UnixSeconds } from '@sidequest/protocol'
import { Effect, Layer, Option, Schema } from 'effect'
import { describe, expect, test } from 'vitest'
import { ModerationSettings } from '../src/Index/Moderation.ts'
import { type Api, origin, withApi } from './HttpWorld.ts'
import { alice, bob, carol, request, signed } from './IndexWorld.ts'
import { serverWorld } from './World.ts'

// The index's hide list: the stage's moderator key hides an event, or every event of a key, from the index's lists by
// a NIP-98 authorization for exactly that request; reads by id still answer, labelled; anyone reads the list; nobody
// else changes it; and a hide is undone the same way.

const now = () => Math.floor(Date.now() / 1000)
/** A fresh world whose moderator is Carol. */
const moderated = () =>
  serverWorld().layer.pipe(
    Layer.provideMerge(Layer.succeed(ModerationSettings, { moderatorPubkey: Option.some(publicKeyOf(carol)) })),
  )

const authorized = async (key: SecretKey, method: string, path: string, body?: string) => {
  const payloadSha256 = body === undefined ? undefined : await Effect.runPromise(textDigest(body))
  const template = httpAuthTemplate(
    { url: `${origin}${path}`, method, ...(payloadSha256 === undefined ? {} : { payloadSha256 }) },
    Schema.decodeSync(UnixSeconds)(now()),
  )
  return httpAuthHeader(signed(template, key))
}

const hide = async (fetch: Api['fetch'], key: SecretKey, target: string, kind: 'event' | 'pubkey') => {
  const path = `/api/moderation/hidden/${target}`
  const body = JSON.stringify({ kind, reason: 'Takedown notice 2026-11-13/1' })
  return fetch(path, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: await authorized(key, 'PUT', path, body) },
    body,
  })
}

const unhide = async (fetch: Api['fetch'], key: SecretKey, target: string) => {
  const path = `/api/moderation/hidden/${target}`
  return fetch(path, { method: 'DELETE', headers: { authorization: await authorized(key, 'DELETE', path) } })
}

const publish = (fetch: Api['fetch'], event: unknown) =>
  fetch('/api/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(event) })

const OpenPage = Schema.Struct({ items: Schema.Array(Schema.Struct({ job: Schema.String })) })
const HiddenList = Schema.Struct({ items: Schema.Array(HiddenTarget) })

const openIds = async (fetch: Api['fetch']) => {
  const body = Schema.decodeUnknownSync(OpenPage)(await (await fetch('/api/index/jobs?stage=open')).json())
  return body.items.map(({ job }) => job)
}

describe('the hide list', () => {
  test('takes a hidden request out of the open list, labels it read by id, and puts it back when unhidden', () =>
    withApi(async ({ fetch }) => {
      const mine = request(alice, now() - 10, 'A logo')
      const theirs = request(bob, now() - 5, 'A banner')
      for (const event of [mine, theirs]) expect((await publish(fetch, event)).status).toBe(200)
      expect(await openIds(fetch)).toEqual([theirs.id, mine.id])

      const hidden = await hide(fetch, carol, mine.id, 'event')
      expect(hidden.status).toBe(200)
      expect(await hidden.json()).toMatchObject({ target: mine.id, kind: 'event', hiddenBy: publicKeyOf(carol) })
      expect(await openIds(fetch)).toEqual([theirs.id])
      const read = await fetch(`/api/events/${mine.id}`)
      expect(read.status).toBe(200)
      expect(read.headers.get('sidequest-labels')).toBe('hidden')
      expect((await fetch(`/api/index/jobs/${mine.id}`)).headers.get('sidequest-labels')).toBe('hidden')
      expect((await fetch(`/api/index/jobs/${theirs.id}`)).headers.get('sidequest-labels')).toBeNull()
      const list = Schema.decodeUnknownSync(HiddenList)(await (await fetch('/api/moderation/hidden')).json())
      expect(list.items).toMatchObject([{ target: mine.id, reason: 'Takedown notice 2026-11-13/1' }])

      expect((await unhide(fetch, carol, mine.id)).status).toBe(200)
      expect(await openIds(fetch)).toEqual([theirs.id, mine.id])
      expect((await fetch(`/api/events/${mine.id}`)).headers.get('sidequest-labels')).toBeNull()
    }, moderated()))

  test('hides every event of a hidden key', () =>
    withApi(async ({ fetch }) => {
      const first = request(bob, now() - 10, 'One')
      const second = request(bob, now() - 5, 'Two')
      for (const event of [first, second]) await publish(fetch, event)
      expect((await hide(fetch, carol, publicKeyOf(bob), 'pubkey')).status).toBe(200)
      expect(await openIds(fetch)).toEqual([])
      expect((await fetch(`/api/events/${second.id}`)).headers.get('sidequest-labels')).toBe('hidden')
    }, moderated()))

  test('refuses any key but the moderator’s, an authorization for another request, and none at all', () =>
    withApi(async ({ fetch }) => {
      const event = request(alice, now() - 10)
      await publish(fetch, event)
      const byBob = await hide(fetch, bob, event.id, 'event')
      expect([byBob.status, await byBob.json()]).toEqual([401, { _tag: 'ModerationRefused', reason: 'notTheKey' }])
      const path = `/api/moderation/hidden/${event.id}`
      const replayed = await fetch(path, {
        method: 'DELETE',
        headers: { authorization: await authorized(carol, 'PUT', path) },
      })
      expect(replayed.status).toBe(401)
      expect((await fetch(path, { method: 'DELETE' })).status).toBe(401)
      expect(await openIds(fetch)).toEqual([event.id])
    }, moderated()))

  test('lets nobody change it on a stage without a moderator key', () =>
    withApi(async ({ fetch }) => {
      const event = request(alice, now() - 10)
      await publish(fetch, event)
      expect((await hide(fetch, carol, event.id, 'event')).status).toBe(503)
      expect(await (await fetch('/api/moderation/hidden')).json()).toEqual({ items: [] })
    }))
})

describe('the relayer’s health', () => {
  test('says a stage without settlement has none, and is never cached', () =>
    withApi(async ({ fetch }) => {
      const read = await fetch('/api/status/settlement')
      expect(read.status).toBe(200)
      expect(read.headers.get('cache-control')).toBe('no-store')
      expect(await read.json()).toMatchObject({ configured: false, relayer: null, balance: null })
    }))
})
