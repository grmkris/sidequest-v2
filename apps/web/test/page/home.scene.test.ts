import { Amount, Cursor, type Listing, UsdcOnArcTestnet } from '@sidequest/protocol'
import { Option } from 'effect'
import { Command, click, expect, given, label, role, scene, submit, text, type, withViewInputs } from 'foldkit/scene'
import { describe, expect as assert, test } from 'vitest'
import { init, Message, type Model, PushSearch, ReadRequests, update, view } from '../../src/page/Home.ts'
import { ada, ben, job, listing } from '../Fixtures.ts'

const home = withViewInputs(view, { language: 'en' })
const next = Cursor.make('page2')
const request = { id: job, buyer: ada, title: 'A logo for my café', expiresAt: 1_800_600_000 }
const offer: Listing = {
  id: listing,
  owner: ben,
  title: 'Hand-drawn logos',
  description: 'By hand.',
  tags: ['logo', 'branding'],
  priceHint: { amount: Amount.make('250000000'), asset: UsdcOnArcTestnet.id },
  state: 'published',
}

/** Home once both reads answered. */
const loaded = (requests: Message, listings: Message): Model =>
  update(update(init(Option.none()).model, requests).model, listings).model

describe('the home page', () => {
  test('reads the open requests and the listings as it opens, and says so meanwhile', () => {
    assert(init(Option.some('logo')).commands?.map((command) => command.name)).toEqual([
      'ReadRequests',
      'SearchListings',
    ])
    scene(
      { update, view: home() },
      given(init(Option.none()).model),
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
      expect(role('link', { name: 'A logo for my café' })).toHaveAttr('href', `/jobs/${job}`),
      expect(role('link', { name: 'Hand-drawn logos' })).toHaveAttr('href', `/listings/${listing}`),
      expect(text('Around 250.00 USDC')).toExist(),
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
})
