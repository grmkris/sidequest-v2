import { expect } from 'bun:test'
import { JobView as FoldedJob } from '@sidequest/fold'
import { LinkedWallet, Person } from '@sidequest/protocol'
import { Effect } from 'effect'
import * as HttpClient from 'effect/http/HttpClient'
import { generatePrivateKey } from 'viem/accounts'
import { startTestRelay } from '../../test/TestRelay.ts'
import { pipeLimits } from '../RelayPipe/PipePolicy.ts'
import {
  apiReadsDuring,
  clickThenSee,
  confirmBackup,
  createLocalKey,
  extensionPerson,
  headlessChromium,
  nostrExtension,
  openPage,
  publishProfile,
  reloadThenUnlock,
  reloadUntilShown,
  reopen,
  storedItems,
  storedLocalKey,
  unexplainedProblems,
  useExtension,
  walletContext,
} from './ChromiumWorld.ts'
import { postJson, signedProfile, signedRequestAndProposal, until } from './EdgeWorld.ts'
import { acceptStanding, postRequest, proposeThenRevise, publishListing, signedRequest } from './MarketWorld.ts'
import { pipeTo, upgradeStatus } from './PipeWorld.ts'

// The Nostr journeys of the native acceptance test (Runtime.native.test.ts), each against the edge at `url`: a
// person's key and wallet link in Chromium, and the relay pipe.

/**
 * A person with a NIP-07 extension links their wallet; the index shows it verified. Their name comes from their own
 * Nostr profile, so the page publishes none: a name-only profile would replace theirs on their relays.
 */
export const linksWalletWithExtension = (url: string) =>
  Effect.gen(function* () {
    const person = yield* walletContext(yield* headlessChromium)
    const { pubkey } = yield* nostrExtension(person.context)
    const { page, problems, notFound } = yield* openPage(person.context, url)
    yield* useExtension(page, pubkey)
    yield* Effect.promise(() =>
      page.getByText('Your name comes from your existing Nostr profile.', { exact: false }).waitFor({ timeout: 15000 }),
    )
    expect(yield* Effect.promise(() => page.getByRole('button', { name: 'Publish profile' }).count())).toBe(0)

    yield* clickThenSee(page, 'Link your wallet', 'Your wallet is linked to your key.')
    const account = `eip155:5042002:${person.wallet.address.toLowerCase()}`
    const row = page.getByRole('list', { name: 'Linked wallets' }).getByRole('listitem').filter({ hasText: account })
    yield* Effect.promise(() => row.getByText('Verified', { exact: true }).waitFor({ timeout: 15000 }))
    const linked = yield* until(HttpClient.get(`${url}/api/wallets/${account}`), LinkedWallet)
    expect(linked).toMatchObject({ pubkey, verification: 'verified' })
    expect(yield* storedItems(page)).toEqual([['sidequest.signer', JSON.stringify({ signerKind: 'nip07', pubkey })]])
    // No profile was published for the key: the index knows only the link.
    expect((yield* until(HttpClient.get(`${url}/api/people/${pubkey}`), Person)).profile).toBeNull()
    expect(unexplainedProblems(problems, notFound, pubkey)).toEqual([])
  })

/** A person makes a key in the browser behind a confirmed backup and unlocks it after a reload; no secret is stored. */
export const keepsLocalKeyAsBackup = (url: string) =>
  Effect.gen(function* () {
    const { context } = yield* walletContext(yield* headlessChromium)
    const { page, problems, notFound } = yield* openPage(context, `${url}/identity`)
    yield* Effect.promise(() => page.getByText('No Nostr extension was found', { exact: false }).waitFor())
    const password = 'a long acceptance password'
    const ncryptsec = yield* createLocalKey(page, password)
    expect(ncryptsec).toMatch(/^ncryptsec1[02-9ac-hj-np-z]+$/u)
    expect(yield* storedItems(page)).toEqual([])

    // Not without confirming the backup.
    yield* clickThenSee(page, 'Continue', 'Confirm that you saved your backup first.')
    expect(yield* Effect.promise(() => page.getByLabel('Name', { exact: true }).count())).toBe(0)
    yield* confirmBackup(page)

    // No raw secret anywhere: the only 64-hex value kept is the public key, and nothing is an nsec.
    const { pubkey, ...kept } = yield* storedLocalKey(page)
    expect(kept).toEqual({ ncryptsec, otherHex: [], nsec: false })

    yield* reloadThenUnlock(page, password)
    const name = `Local ${generatePrivateKey().slice(2, 10)}`
    yield* publishProfile(page, name)
    const indexed = yield* until(HttpClient.get(`${url}/api/people/${pubkey}`), Person)
    expect(indexed.profile).toMatchObject({ name })
    expect(yield* storedLocalKey(page)).toEqual({ pubkey, ncryptsec, otherHex: [], nsec: false })
    expect(unexplainedProblems(problems, notFound, pubkey)).toEqual([])
  })

/** A page reaches a relay through the edge: a subscription to its end, an event published and read back, the caps. */
export const pipesToRelay = (url: string) =>
  Effect.gen(function* () {
    const relay = yield* Effect.acquireRelease(
      Effect.promise(() => startTestRelay()),
      (started) => Effect.promise(() => started.close()),
    )
    const page = yield* pipeTo(url, relay.url, { cookie: '__Host-sidequest=secret', authorization: 'Bearer secret' })
    yield* page.send(['REQ', 'empty', { kinds: [0] }])
    expect(yield* page.frame('EOSE')).toEqual(['EOSE', 'empty'])
    // The relay sees none of the visitor's headers: no cookie, authorization or origin.
    expect(relay.handshakes).toHaveLength(1)
    for (const name of ['cookie', 'authorization', 'origin']) expect(relay.handshakes[0]).not.toHaveProperty(name)
    const { event, pubkey } = signedProfile('Piped')
    yield* page.send(['EVENT', event])
    expect(yield* page.frame('OK')).toEqual(['OK', event.id, true, ''])
    expect([...relay.events.keys()]).toEqual([event.id])
    yield* page.send(['REQ', 'mine', { kinds: [0], authors: [pubkey] }])
    expect(yield* page.frame('EVENT')).toEqual(['EVENT', 'mine', event])
    expect(yield* page.frame('EOSE')).toEqual(['EOSE', 'mine'])
    // A message over the client cap ends the pipe with 1009, the message-too-big code, before the relay sees it.
    yield* page.sendText('x'.repeat(pipeLimits.clientFrameLength + 1))
    expect(yield* page.closed).toBe(1009)
  })

/** The edge refuses a pipe from another origin, and to a relay the policy does not allow. */
export const refusesForeignPipes = (url: string) =>
  Effect.gen(function* () {
    const relay = yield* Effect.acquireRelease(
      Effect.promise(() => startTestRelay()),
      (started) => Effect.promise(() => started.close()),
    )
    expect(yield* upgradeStatus(url, relay.url, 'https://evil.example')).toBe(403)
    expect(relay.requests).toEqual([])
    for (const disallowed of ['ws://10.0.0.8:4848', 'wss://relay.damus.io:8443', 'https://relay.damus.io'])
      expect(yield* upgradeStatus(url, disallowed, url)).toBe(400)
  })

/** A request and a proposal published through the edge fold into a job the index reads as proposed. */
export const foldsPublishedJob = (url: string) =>
  Effect.gen(function* () {
    const { request, proposal } = yield* signedRequestAndProposal
    for (const event of [request, proposal]) expect((yield* postJson(`${url}/api/events`, event)).status).toBe(200)
    const job = yield* until(
      HttpClient.get(`${url}/api/index/jobs/${request.id}`),
      FoldedJob,
      (view) => view.stage === 'proposed',
    )
    expect(job).toMatchObject({ job: request.id, buyer: request.pubkey, proposals: [{ id: proposal.id }] })
  })

// The marketplace in Chromium: two people, each with their own NIP-07 key and test wallet in their own browser
// context, negotiate a job through signed events; a seller's listing is found by search; the server renders the
// index's requests without JavaScript.

const unique = () => generatePrivateKey().slice(2, 10)

/**
 * A buyer posts a request and sees it on the home page, rendered by the server with its data; a bidder with a linked
 * wallet proposes and revises; the buyer sees the revision, the first labelled revised, and accepts it.
 */
export const negotiatesOnEvents = (url: string) =>
  Effect.gen(function* () {
    const browser = yield* headlessChromium
    const buyer = yield* extensionPerson(browser, url, false)
    const title = `A poster for the acceptance run ${unique()}`
    const jobPath = yield* postRequest(buyer.page, title)

    const home = yield* openPage(buyer.context, url)
    yield* reloadUntilShown(home.page, title)
    expect(yield* Effect.promise(() => home.page.getByRole('link', { name: title }).getAttribute('href'))).toBe(jobPath)
    // Hydrated from what the server read: the page reads none of the index's lists again.
    const homeReads = yield* apiReadsDuring(home.page, url)
    expect(homeReads.filter((path) => path.startsWith('/api/index/'))).toEqual([])

    const bidder = yield* extensionPerson(browser, url, true)
    yield* reopen(bidder.page, `${url}${jobPath}`)
    yield* proposeThenRevise(bidder.page, '250', '300')

    yield* reopen(buyer.page, `${url}${jobPath}`)
    yield* Effect.promise(() => buyer.page.getByText('Revised', { exact: true }).waitFor({ timeout: 15000 }))
    yield* acceptStanding(buyer.page)
    const folded = yield* until(
      HttpClient.get(`${url}/api/index/jobs/${jobPath.slice('/jobs/'.length)}`),
      FoldedJob,
      (view) => view.stage === 'accepted',
    )
    // Both may be signed within one second, so the fold's display order may be either: compare as a set.
    const first = folded.proposals.find((proposal) => proposal.content.previous === undefined)
    const revision = folded.proposals.find((proposal) => proposal.content.previous !== undefined)
    expect([first?.superseded, first?.accepted, revision?.superseded, revision?.accepted]).toEqual([
      true,
      false,
      false,
      true,
    ])
    expect(revision?.content.previous).toBe(first?.id)
    for (const person of [buyer, home])
      expect(unexplainedProblems(person.problems, person.notFound, buyer.pubkey)).toEqual([])
    expect(unexplainedProblems(bidder.problems, bidder.notFound, bidder.pubkey)).toEqual([])
  })

/** A seller publishes a listing with their key; a visitor finds it by searching for a word of its title. */
export const findsPublishedListing = (url: string) =>
  Effect.gen(function* () {
    const browser = yield* headlessChromium
    const seller = yield* extensionPerson(browser, url, false)
    const word = `inkwork${unique()}`
    const title = `Hand-drawn logos, ${word}`
    const listingPath = yield* publishListing(seller.page, title)
    expect(listingPath.startsWith(`/listings/${seller.pubkey}/hand-drawn-logos-inkwork`)).toBe(true)

    const visitor = yield* walletContext(browser)
    const search = yield* openPage(visitor.context, `${url}/?q=${word}`)
    const found = search.page.getByRole('list', { name: 'Listings' }).getByRole('link', { name: title })
    expect(yield* Effect.promise(() => found.getAttribute('href'))).toBe(listingPath)
    expect(unexplainedProblems(seller.problems, seller.notFound, seller.pubkey)).toEqual([])
    expect(search.problems).toEqual([])
  })

/** A request published through the edge is in the HTML of the home page and of its job page, without JavaScript. */
export const rendersRequestsOnTheServer = (url: string) =>
  Effect.gen(function* () {
    const title = `Server rendered ${unique()}`
    const request = yield* signedRequest(title)
    expect((yield* postJson(`${url}/api/events`, request)).status).toBe(200)
    const html = (path: string) =>
      HttpClient.get(`${url}${path}`, { headers: { accept: 'text/html' } }).pipe(
        Effect.flatMap((response) =>
          Effect.map(response.text, (body) => ({ body, cacheControl: response.headers['cache-control'] })),
        ),
      )
    const home = yield* html('/')
    expect(home.body).toContain(title)
    expect(home.body).toContain(`/jobs/${request.id}`)
    expect(home.cacheControl).toBe('public, max-age=0, s-maxage=10, must-revalidate')
    const page = yield* html(`/jobs/${request.id}`)
    expect(page.body).toContain(title)
    expect(page.body).toContain('No proposals yet.')
  })
