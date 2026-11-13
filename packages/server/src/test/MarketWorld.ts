import { expect } from 'bun:test'
import { Entropy, finalizeEvent, SecretKey } from '@sidequest/nostr'
import { buildSidequestEvent, jobRequest } from '@sidequest/nostr/vocabulary'
import { Clock, Effect, Schema } from 'effect'
import type { Page } from 'playwright'
import { generatePrivateKey } from 'viem/accounts'
import { clickThenSee, fillIn } from './ChromiumWorld.ts'
import { day } from './EdgeWorld.ts'

// What people do on the marketplace pages in Chromium, for the Nostr journeys (NostrJourneys.ts): post a request,
// propose and revise, accept, publish a listing. Each step waits for what the page says once it is done.

/** The buyer posts a request from the header's link; the request's event id is the job page's address. */
export const postRequest = (page: Page, title: string) =>
  Effect.gen(function* () {
    yield* Effect.promise(() =>
      page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Post a request' }).click(),
    )
    yield* fillIn(page, { 'What do you need?': title, Details: 'A2, two colours, by Friday.' })
    yield* Effect.promise(() => page.getByRole('button', { name: 'Post the request' }).click())
    yield* Effect.promise(() => page.waitForURL(/\/jobs\/[0-9a-f]{64}$/u, { timeout: 15000 }))
    yield* Effect.promise(() => page.getByRole('heading', { level: 1, name: title }).waitFor({ timeout: 15000 }))
    return new URL(page.url()).pathname
  })

/** A bidder proposes at `price` USDC, then revises it to `revised`, and sees the first labelled as revised. */
export const proposeThenRevise = (page: Page, price: string, revised: string) =>
  Effect.gen(function* () {
    yield* Effect.promise(() => page.getByRole('button', { name: 'Make a proposal' }).click({ timeout: 15000 }))
    yield* fillIn(page, {
      'Title of your proposal': 'Two colours, hand-drawn',
      'What you will deliver': 'An SVG logo\nA PNG at 2048 px',
      'Price in USDC': price,
    })
    yield* clickThenSee(page, 'Send proposal', 'Your proposal is published.')
    yield* Effect.promise(() => page.getByRole('button', { name: 'Revise' }).click({ timeout: 15000 }))
    yield* fillIn(page, { 'Price in USDC': revised })
    yield* Effect.promise(() => page.getByRole('button', { name: 'Publish the revision' }).click())
    yield* Effect.promise(() => page.getByText('Revised', { exact: true }).waitFor({ timeout: 15000 }))
  })

/** The buyer accepts the one proposal that still stands, confirming on the slip that says it binds nothing yet. */
export const acceptStanding = (page: Page) =>
  Effect.gen(function* () {
    const accept = page.getByRole('button', { name: 'Accept this proposal' })
    yield* Effect.promise(() => accept.waitFor({ timeout: 15000 }))
    expect(yield* Effect.promise(() => accept.count())).toBe(1)
    yield* Effect.promise(() => accept.click())
    const slip = page.getByRole('group', { name: 'Confirm the acceptance' })
    yield* Effect.promise(() => slip.getByText('It is a signal, not a contract', { exact: false }).waitFor())
    yield* Effect.promise(() => slip.getByRole('button', { name: 'Accept this proposal' }).click())
    yield* Effect.promise(() =>
      page.getByText('Your acceptance is published.', { exact: false }).waitFor({ timeout: 15000 }),
    )
    yield* Effect.promise(() => page.getByText('Proposal accepted', { exact: true }).waitFor({ timeout: 15000 }))
  })

/** A seller publishes a listing from the home page's link; the address of its page, by their key and its slug. */
export const publishListing = (page: Page, title: string) =>
  Effect.gen(function* () {
    yield* Effect.promise(() => page.getByRole('link', { name: 'Sidequest, open requests' }).click())
    yield* Effect.promise(() => page.getByRole('link', { name: 'Publish a listing' }).click())
    yield* fillIn(page, {
      'What do you offer?': title,
      Summary: 'Logos drawn by hand, in ink.',
      Description: 'Two rounds of sketches, then the final drawing.',
      Tags: 'Logo, Ink',
      'Usual price in USDC (optional)': '120',
    })
    yield* Effect.promise(() => page.getByRole('button', { name: 'Publish the listing' }).click())
    yield* Effect.promise(() => page.waitForURL(/\/listings\/[0-9a-f]{64}\/[a-z0-9-]+$/u, { timeout: 15000 }))
    yield* Effect.promise(() => page.getByRole('heading', { level: 1, name: title }).waitFor({ timeout: 15000 }))
    return new URL(page.url()).pathname
  })

/** A request titled `title` by a fresh key, signed now, open for a week. */
export const signedRequest = (title: string) =>
  Effect.gen(function* () {
    const buyer = yield* Schema.decodeEffect(SecretKey)(generatePrivateKey().slice(2))
    const createdAt = Math.floor((yield* Clock.currentTimeMillis) / 1000)
    const content = { title, description: 'In the HTML.', expiresAt: createdAt + 7 * day }
    const template = yield* buildSidequestEvent(jobRequest, content, { createdAt })
    return finalizeEvent(template, buyer, yield* Schema.decodeEffect(Entropy)(new Uint8Array(32)))
  })
