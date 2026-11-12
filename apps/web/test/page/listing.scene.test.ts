import { Amount, type Listing, UsdcOnArcTestnet } from '@sidequest/protocol'
import { Option } from 'effect'
import {
  Command,
  click,
  expect,
  expectOutMessage,
  given,
  label,
  role,
  scene,
  submit,
  text,
  type,
  withViewInputs,
} from 'foldkit/scene'
import { describe, test } from 'vitest'
import * as ListingPage from '../../src/page/ListingPage.ts'
import * as NewListing from '../../src/page/NewListing.ts'
import { Problem } from '../../src/Problem.ts'
import { Session } from '../../src/Session.ts'
import { ada, adaSession, ben, listing } from '../Fixtures.ts'

const published: Listing = {
  id: listing,
  owner: ada,
  title: 'Hand-drawn logos',
  description: 'By hand, in ink.',
  tags: ['logo'],
  priceHint: { amount: Amount.make('250500000'), asset: UsdcOnArcTestnet.id },
  state: 'published',
}

const read = (current: Listing) =>
  ListingPage.update(
    ListingPage.init('en', listing).model,
    ListingPage.Message.SucceededReadListing({ listing: current }),
  ).model

describe('publishing a listing', () => {
  test('sends the title, tags and price hint in atomic units, then opens the listing', () => {
    scene(
      {
        update: NewListing.update,
        view: withViewInputs(NewListing.view, { session: Session.SignedIn({ session: adaSession }) })(),
      },
      given(NewListing.init('en')),
      type(label('What do you offer?'), 'Hand-drawn logos'),
      type(label('Description'), 'By hand, in ink.'),
      type(label('Tags'), 'logo, branding, logo'),
      type(label('Usual price in USDC (optional)'), '250,5'),
      submit(role('form')),
      expect(text('Write an amount like 250.50, with at most 6 decimals.')).toExist(),
      type(label('Usual price in USDC (optional)'), '250.5'),
      submit(role('form')),
      Command.resolve(
        NewListing.PublishListing({
          details: {
            title: 'Hand-drawn logos',
            description: 'By hand, in ink.',
            tags: ['logo', 'branding'],
            priceHint: { amount: Amount.make('250500000'), asset: UsdcOnArcTestnet.id },
          },
        }),
        NewListing.Message.SucceededPublishListing({ listing }),
      ),
      expectOutMessage(NewListing.OutMessage.Published({ listing })),
    )
  })
})

describe('a listing’s page', () => {
  test('shows anyone the listing, without its owner’s controls', () => {
    scene(
      { update: ListingPage.update, view: withViewInputs(ListingPage.view, { maybeAccount: Option.some(ben) })() },
      given(read(published)),
      expect(role('heading', { level: 1, name: 'Hand-drawn logos' })).toExist(),
      expect(text('Around 250.50 USDC')).toExist(),
      expect(role('button', { name: 'Edit listing' })).not.toExist(),
    )
  })

  test('lets its owner edit it, with the fields filled in, and reads it again after saving', () => {
    scene(
      { update: ListingPage.update, view: withViewInputs(ListingPage.view, { maybeAccount: Option.some(ada) })() },
      given(read(published)),
      click(role('button', { name: 'Edit listing' })),
      expect(label('Usual price in USDC (optional)')).toHaveValue('250.50'),
      type(label('What do you offer?'), 'Logos, drawn by hand'),
      submit(role('form')),
      Command.resolve(
        ListingPage.UpdateListing({
          id: listing,
          details: {
            title: 'Logos, drawn by hand',
            description: 'By hand, in ink.',
            tags: ['logo'],
            priceHint: { amount: Amount.make('250500000'), asset: UsdcOnArcTestnet.id },
          },
        }),
        ListingPage.Message.SucceededUpdateListing(),
      ),
      Command.resolve(
        ListingPage.ReadListing({ id: listing }),
        ListingPage.Message.SucceededReadListing({ listing: { ...published, title: 'Logos, drawn by hand' } }),
      ),
      expect(role('heading', { level: 1, name: 'Logos, drawn by hand' })).toExist(),
    )
  })

  test('lets its owner withdraw it, and shows a refusal', () => {
    scene(
      { update: ListingPage.update, view: withViewInputs(ListingPage.view, { maybeAccount: Option.some(ada) })() },
      given(read(published)),
      click(role('button', { name: 'Withdraw listing' })),
      Command.resolve(
        ListingPage.WithdrawListing({ id: listing }),
        ListingPage.Message.FailedWithdrawListing({ problem: Problem.Conflict({ reason: 'ListingNotPublished' }) }),
      ),
      expect(role('alert')).toContainText("That listing has been withdrawn, so it can't change."),
    )
  })
})
