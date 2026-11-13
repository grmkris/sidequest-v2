import { OpenJob } from '../../src/OpenJob.ts'
import { Cursor, IndexListing, UsdcOnArcTestnet } from '@sidequest/protocol'
import { Option, Schema } from 'effect'
import { Command, click, expect, given, label, role, scene, submit, text, type, withViewInputs } from 'foldkit/scene'
import { describe, expect as assert, test } from 'vitest'
import {
  init,
  Message,
  type Model,
  PushSearch,
  ReadNames,
  ReadRequests,
  SearchListings,
  update,
  view,
} from '../../src/page/Home.ts'
import { Preload } from '../../src/Preload.ts'
import { bidderKey, buyerKey, now, requestId } from '../Fixtures.ts'

const home = withViewInputs(view, { language: 'en', timeZone: 'UTC' })
const next = Cursor.make('page2')
const request: OpenJob = Schema.decodeSync(OpenJob)({
  job: requestId,
  buyer: buyerKey,
  createdAt: now,
  request: { title: 'A logo for my café', description: 'Warm colours.', expiresAt: 1_800_600_000 },
  expired: false,
  proposals: 2,
})
const offer: IndexListing = Schema.decodeSync(IndexListing)({
  pubkey: bidderKey,
  slug: 'hand-drawn-logos',
  event: 'f5'.repeat(32),
  createdAt: now,
  title: 'Hand-drawn logos',
  summary: 'By hand.',
  topics: ['logo', 'branding'],
  price: { amount: '250000000', asset: UsdcOnArcTestnet.id },
  network: UsdcOnArcTestnet.network,
  status: 'active',
  publishedAt: now,
  author: { name: 'Ben', walletVerified: true },
})

/** Home once both reads answered. */
const loaded = (requests: Message, listings: Message): Model =>
  update(update(init(Option.none(), Option.none()).model, requests).model, listings).model

describe('the home page', () => {
  test('reads the open requests and the listings from the index as it opens, and says so meanwhile', () => {
    assert(init(Option.some('logo'), Option.none()).commands?.map((command) => command.name)).toEqual([
      ReadRequests.name,
      SearchListings.name,
    ])
    scene(
      { update, view: home() },
      given(init(Option.none(), Option.none()).model),
      expect(text('Loading open requests…')).toExist(),
      expect(text('Loading listings…')).toExist(),
    )
  })

  test('lists open requests and listings, each linking to its page, and pages on', () => {
    scene(
      { update, view: home() },
      given(
        loaded(
          Message.SucceededReadRequests({ items: [request], next }),
          Message.SucceededSearchListings({ items: [offer], next: null }),
        ),
      ),
      expect(role('link', { name: 'A logo for my café' })).toHaveAttr('href', `/jobs/${requestId}`),
      expect(role('link', { name: 'Hand-drawn logos' })).toHaveAttr('href', `/listings/${bidderKey}/hand-drawn-logos`),
      expect(text('2 proposals')).toExist(),
      expect(text('By Ben · Around 250.00 USDC')).toExist(),
      click(role('button', { name: 'Show more' })),
      expect(role('button', { name: 'Show more' })).toBeDisabled(),
      Command.resolve(
        ReadRequests({ maybeCursor: Option.some(next) }),
        Message.SucceededReadRequests({ items: [], next: null }),
      ),
      expect(role('button', { name: 'Show more' })).not.toExist(),
      expect(role('link', { name: 'A logo for my café' })).toExist(),
    )
  })

  test('searches listings through the address, so Back and a shared link keep the search', () => {
    scene(
      { update, view: home() },
      given(
        loaded(
          Message.SucceededReadRequests({ items: [], next: null }),
          Message.SucceededSearchListings({ items: [], next: null }),
        ),
      ),
      expect(text('No open requests right now. Post the first one.')).toExist(),
      type(label('Search listings'), '  logo '),
      submit(role('search')),
      Command.resolve(PushSearch({ maybeQuery: Option.some('logo') }), Message.CompletedPushSearch()),
    )
  })

  test('asks once for the names of the buyers, and shows a buyer without a profile by their short npub', () => {
    const requested = update(
      init(Option.none(), Option.none()).model,
      Message.SucceededReadRequests({ items: [request], next: null }),
    )
    assert(requested.commands?.map((command) => [command.name, command.args])).toEqual([
      [ReadNames.name, { pubkeys: [buyerKey] }],
    ])
    assert(
      update(requested.model, Message.SucceededReadRequests({ items: [request], next: null })).commands ?? [],
    ).toEqual([])
    scene(
      { update, view: home() },
      given(
        update(
          requested.model,
          Message.SucceededReadNames({ names: [{ pubkey: buyerKey, name: null, walletVerified: false }] }),
        ).model,
      ),
      expect(text(/^npub1[02-9ac-hj-np-z]{5}…[02-9ac-hj-np-z]{4} · open until/u)).toExist(),
    )
  })

  test('shows the open requests and listings the server read, with their names, and reads nothing', () => {
    const opened = init(
      Option.none(),
      Option.some(
        Preload.Home({
          requests: { items: [request], next: null },
          listings: { items: [offer], next: null },
          names: [{ pubkey: buyerKey, name: 'Ada Lovelace', walletVerified: true }],
        }),
      ),
    )
    assert(opened.commands ?? []).toEqual([])
    scene(
      { update, view: home() },
      given(opened.model),
      expect(role('link', { name: 'A logo for my café' })).toExist(),
      expect(text(/^Ada Lovelace · open until/u)).toExist(),
      expect(text('By Ben · Around 250.00 USDC')).toExist(),
    )
  })
})
