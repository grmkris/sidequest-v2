import { Amount, IndexListingDetail, UsdcOnArcTestnet } from '@sidequest/protocol'
import { Option, Schema } from 'effect'
import { Command, expectOutMessage, given, message, model, story } from 'foldkit/story'
import { describe, expect, test } from 'vitest'
import { FormStatus } from '../../src/Forms.ts'
import { Me, Standing } from '../../src/Me.ts'
import * as ListingForm from '../../src/page/ListingForm.ts'
import * as ListingPage from '../../src/page/ListingPage.ts'
import * as NewListing from '../../src/page/NewListing.ts'
import { Preload } from '../../src/Preload.ts'
import { PublishFailure } from '../../src/Publishing.ts'
import { Problem } from '../../src/Problem.ts'
import { bidderKey, now, otherKey } from '../Fixtures.ts'

const seller = Me.Ready({
  identity: { signerKind: 'nip07', pubkey: bidderKey },
  standing: Standing.Known({ maybeName: Option.some('Ben'), wallets: [], agents: [] }),
})

const listing = Schema.decodeSync(IndexListingDetail)({
  pubkey: bidderKey,
  slug: 'hand-drawn-logos-0a1b',
  event: 'f5'.repeat(32),
  createdAt: now,
  title: 'Hand-drawn logos',
  summary: 'Logos drawn by hand.',
  description: 'By hand, in ink.',
  topics: ['logo'],
  price: { amount: '250000000', asset: UsdcOnArcTestnet.id },
  network: UsdcOnArcTestnet.network,
  status: 'active',
  publishedAt: now - 3600,
  author: { name: 'Ben', walletVerified: true },
})

const form = (formMessage: ListingForm.Message) => NewListing.Message.GotListingFormMessage({ message: formMessage })
const editForm = (formMessage: ListingForm.Message) =>
  ListingPage.Message.GotListingFormMessage({ message: formMessage })

const opened = (me: Me) =>
  ListingPage.init('en', { pubkey: bidderKey, slug: listing.slug }, me, Option.some(Preload.Listing({ listing })))

const draft: ListingForm.ListingDraft = {
  title: 'Hand-drawn logos',
  summary: 'Logos drawn by hand.',
  description: 'By hand, in ink.',
  topics: ['logo', 'branding'],
  price: { amount: Amount.make('250000000'), asset: UsdcOnArcTestnet.id },
}

describe('publishing a listing', () => {
  test('checks the fields, then signs and publishes the listing, lowercasing its topics, and opens its page', () => {
    story(
      NewListing.update,
      given(NewListing.init('en', seller)),
      message(form(ListingForm.Message.SubmittedListing())),
      Command.expectNone(),
      model((page) => expect(page.form.status).toEqual(FormStatus.Invalid())),
      message(form(ListingForm.Message.UpdatedTitle({ value: 'Hand-drawn logos' }))),
      message(form(ListingForm.Message.UpdatedSummary({ value: 'Logos drawn by hand.' }))),
      message(form(ListingForm.Message.UpdatedDescription({ value: 'By hand, in ink.' }))),
      message(form(ListingForm.Message.UpdatedTopics({ value: 'Logo, branding, logo' }))),
      message(form(ListingForm.Message.UpdatedPrice({ value: '250' }))),
      message(form(ListingForm.Message.SubmittedListing())),
      Command.expectExact(NewListing.PublishListing({ draft })),
      Command.resolve(
        NewListing.PublishListing,
        NewListing.Message.SucceededPublishListing({ pubkey: bidderKey, slug: listing.slug }),
      ),
      expectOutMessage(NewListing.OutMessage.Published({ pubkey: bidderKey, slug: listing.slug })),
    )
  })

  test('without a signer, leads to the identity page and publishes nothing', () => {
    story(
      NewListing.update,
      given(NewListing.init('en', Me.NoSigner())),
      message(form(ListingForm.Message.UpdatedTitle({ value: 'Hand-drawn logos' }))),
      message(form(ListingForm.Message.UpdatedSummary({ value: 'Logos drawn by hand.' }))),
      message(form(ListingForm.Message.UpdatedDescription({ value: 'By hand, in ink.' }))),
      message(form(ListingForm.Message.SubmittedListing())),
      expectOutMessage(NewListing.OutMessage.SignerMissing()),
      Command.expectNone(),
      model((page) => expect(page.form.status).toEqual(FormStatus.Editing())),
    )
  })

  test('a slug is the title’s words, lowercase, joined by hyphens', () => {
    expect(NewListing.slugBase('  Hand-drawn Logos, Café & More!  ')).toBe('hand-drawn-logos-cafe-more')
    expect(NewListing.slugBase('日本語')).toBe('listing')
  })
})

describe('a listing’s page', () => {
  test('shows the listing the server read without reading it again', () => {
    expect(opened(seller).commands ?? []).toEqual([])
    expect(
      ListingPage.init('en', { pubkey: bidderKey, slug: listing.slug }, seller, Option.none()).commands?.map(
        (command) => command.name,
      ),
    ).toEqual(['ReadListing'])
  })

  test('its seller publishes a new version under the same slug, keeping its status and first publication, then reads it past the cache', () => {
    story(
      ListingPage.update,
      given(opened(seller).model),
      message(ListingPage.Message.ClickedEdit()),
      message(editForm(ListingForm.Message.UpdatedTitle({ value: 'Hand-drawn logos, in ink' }))),
      message(editForm(ListingForm.Message.SubmittedListing())),
      Command.expectExact(
        ListingPage.PublishVersion({
          listing,
          draft: {
            title: 'Hand-drawn logos, in ink',
            summary: listing.summary,
            description: listing.description,
            topics: ['logo'],
            price: { amount: Amount.make('250000000'), asset: UsdcOnArcTestnet.id },
          },
        }),
      ),
      Command.resolve(ListingPage.PublishVersion, ListingPage.Message.SucceededPublishVersion()),
      model((page) => expect(page.mode).toEqual(ListingPage.Mode.Viewing({ maybeFailure: Option.none() }))),
      Command.resolve(
        ListingPage.ReadListing({ pubkey: bidderKey, slug: listing.slug, fresh: true }),
        ListingPage.Message.SucceededReadListing({ listing }),
      ),
    )
  })

  test('only its seller edits it; without a signer, editing leads to the identity page', () => {
    expect(
      ListingPage.isSeller(
        opened(Me.Ready({ identity: { signerKind: 'local', pubkey: otherKey }, standing: Standing.Reading() })).model,
      ),
    ).toBe(false)
    expect(ListingPage.isSeller(opened(seller).model)).toBe(true)
    story(
      ListingPage.update,
      given(opened(Me.NoSigner()).model),
      message(ListingPage.Message.ClickedEdit()),
      expectOutMessage(ListingPage.OutMessage.SignerMissing()),
    )
  })

  test('a version the index refused keeps the form, with the reason', () => {
    const failure = PublishFailure.Failed({ problem: Problem.Unreachable() })
    story(
      ListingPage.update,
      given(opened(seller).model),
      message(ListingPage.Message.ClickedEdit()),
      message(editForm(ListingForm.Message.SubmittedListing())),
      Command.resolve(ListingPage.PublishVersion, ListingPage.Message.FailedPublishVersion({ failure })),
      model((page) =>
        expect(ListingPage.Mode.guards.Editing(page.mode) && Option.contains(page.mode.maybeFailure, failure)).toBe(
          true,
        ),
      ),
    )
  })
})
