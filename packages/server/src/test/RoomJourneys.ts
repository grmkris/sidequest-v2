import { expect } from 'bun:test'
import { JobView as FoldedJob } from '@sidequest/fold'
import { Effect } from 'effect'
import * as HttpClient from 'effect/http/HttpClient'
import type { Page } from 'playwright'
import { generatePrivateKey } from 'viem/accounts'
import type { TestRelay } from '../../test/TestRelay.ts'
import {
  clickThenSee,
  extensionPerson,
  fillIn,
  headlessChromium,
  nostrExtension,
  openPage,
  reopen,
  unexplainedProblems,
  useExtension,
  walletContext,
} from './ChromiumWorld.ts'
import { until } from './EdgeWorld.ts'
import { postRequest } from './MarketWorld.ts'

// Rooms in Chromium (ADR-0004): two people, each with a NIP-07 extension that has `nip44`, talk in a job's room through
// the edge's relay pipe and an inbox relay that hands gift wraps only to their authenticated recipients. Nothing of the
// conversation passes through Sidequest's API; a private proposal does, once the buyer publishes it.

/** Long enough for a polling pass (every 15 s while the panel is open) and the relay round trips. */
const patience = { timeout: 40_000 }

/** On the identity page: publish the stage's default inbox relays, which the person does not have yet. */
const publishInboxRelays = (page: Page) =>
  clickThenSee(page, 'Publish inbox relays', 'Your inbox relays are published.')

/** On the job page: open the conversation and wait for its first pass. */
const openConversation = (page: Page) =>
  Effect.gen(function* () {
    yield* Effect.promise(() => page.getByRole('button', { name: 'Open the conversation' }).click(patience))
    yield* Effect.promise(() => page.getByLabel('Your message').waitFor(patience))
  })

/** Writes and sends a message, and waits until the panel says how many relays took it. */
const write = (page: Page, text: string) =>
  Effect.gen(function* () {
    yield* fillIn(page, { 'Your message': text })
    yield* Effect.promise(() => page.getByRole('button', { name: 'Send', exact: true }).click())
    yield* Effect.promise(() => page.getByText(/^Sent to \d+ of \d+ relays\.$/u).waitFor(patience))
  })

const sees = (page: Page, text: string) =>
  Effect.promise(() => page.getByText(text, { exact: true }).first().waitFor(patience))

/** The bidder proposes privately: signed, and sent only into their room with the buyer. */
const proposePrivately = (page: Page) =>
  Effect.gen(function* () {
    yield* Effect.promise(() => page.getByRole('button', { name: 'Make a proposal' }).click(patience))
    yield* fillIn(page, {
      'Title of your proposal': 'A private offer',
      'What you will deliver': 'An SVG logo',
      'Price in USDC': '275',
    })
    yield* Effect.promise(() =>
      page.getByLabel('Who sees this proposal').selectOption({ label: 'Only the buyer: send it privately' }),
    )
    yield* clickThenSee(page, 'Send proposal', 'Your proposal was sent privately to the buyer.')
  })

const jobRead = (url: string, job: string) => HttpClient.get(`${url}/api/index/jobs/${job}`)

/**
 * A buyer and a bidder set up inbox relays, talk in the job's room, keep the transcript across a reload, and read it
 * on a second device; the bidder's private proposal shows on the buyer's page, and becomes public, and fundable, only
 * when the buyer publishes it.
 */
export const talksInARoom = (url: string, inbox: TestRelay) =>
  Effect.gen(function* () {
    const browser = yield* headlessChromium
    const buyer = yield* extensionPerson(browser, url, true, { nip44: true })
    yield* publishInboxRelays(buyer.page)
    const bidder = yield* extensionPerson(browser, url, true, { nip44: true })
    yield* publishInboxRelays(bidder.page)
    const jobPath = yield* postRequest(buyer.page, `A room for the acceptance run ${generatePrivateKey().slice(2, 10)}`)
    const job = jobPath.slice('/jobs/'.length)

    yield* reopen(bidder.page, `${url}${jobPath}`)
    yield* openConversation(bidder.page)
    yield* write(bidder.page, 'Hello from the bidder. <b>Not bold</b> https://example.com')

    yield* reopen(buyer.page, `${url}${jobPath}`)
    yield* openConversation(buyer.page)
    yield* sees(buyer.page, 'Hello from the bidder. <b>Not bold</b> https://example.com')
    // Plain text: no element from the message, and its link is no link.
    expect(yield* Effect.promise(() => buyer.page.locator('ol b').count())).toBe(0)
    expect(yield* Effect.promise(() => buyer.page.getByRole('link', { name: 'https://example.com' }).count())).toBe(0)
    // An extension can read the room but not prove a message from it, and the panel says so.
    yield* Effect.promise(() =>
      buyer.page
        .getByText('Saving a message as evidence needs a key held in this browser.', { exact: false })
        .waitFor(),
    )
    expect(yield* Effect.promise(() => buyer.page.getByRole('button', { name: 'Save as evidence' }).count())).toBe(0)
    yield* write(buyer.page, 'Hello from the buyer.')

    // A reload keeps the transcript, and the inbox relay handed wraps out only after authentication.
    yield* reopen(bidder.page, `${url}${jobPath}`)
    yield* openConversation(bidder.page)
    yield* sees(bidder.page, 'Hello from the buyer.')
    for (const person of [buyer, bidder]) expect(inbox.authenticated.has(person.pubkey)).toBe(true)

    // A private proposal: in the room only, until the buyer publishes it.
    yield* proposePrivately(bidder.page)
    const before = yield* until(jobRead(url, job), FoldedJob)
    expect(before.proposals).toEqual([])
    yield* reopen(buyer.page, `${url}${jobPath}`)
    yield* openConversation(buyer.page)
    yield* Effect.promise(() => buyer.page.getByText('Private', { exact: true }).first().waitFor(patience))
    yield* clickThenSee(buyer.page, 'Make public to fund', 'Publishing it makes this signed proposal public')
    yield* Effect.promise(() => buyer.page.getByRole('button', { name: 'Publish it' }).click())
    const after = yield* until(jobRead(url, job), FoldedJob, (view) => view.proposals.length === 1)
    expect(after.proposals[0]?.author).toBe(bidder.pubkey)
    yield* Effect.promise(() => buyer.page.getByRole('button', { name: 'Fund this proposal' }).waitFor(patience))

    // A second device on the bidder's key reads the history, its own messages included.
    const laptop = yield* walletContext(browser)
    yield* nostrExtension(laptop.context, { nip44: true, key: bidder.key })
    const second = yield* openPage(laptop.context, url)
    yield* useExtension(second.page, bidder.pubkey)
    yield* reopen(second.page, `${url}${jobPath}`)
    yield* openConversation(second.page)
    yield* sees(second.page, 'Hello from the buyer.')
    yield* sees(second.page, 'Hello from the bidder. <b>Not bold</b> https://example.com')

    for (const person of [buyer, bidder]) {
      expect(unexplainedProblems(person.problems, person.notFound, person.pubkey)).toEqual([])
    }
  })
