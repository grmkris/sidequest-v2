import { expect } from 'bun:test'
import { JobView as FoldedJob } from '@sidequest/fold'
import { LinkedWallet, Person } from '@sidequest/protocol'
import { Effect } from 'effect'
import * as HttpClient from 'effect/http/HttpClient'
import { generatePrivateKey } from 'viem/accounts'
import { startTestRelay } from '../../test/TestRelay.ts'
import { pipeLimits } from '../RelayPipe/PipePolicy.ts'
import {
  clickThenSee,
  confirmBackup,
  createLocalKey,
  headlessChromium,
  nostrExtension,
  openPage,
  publishProfile,
  reloadThenUnlock,
  storedItems,
  storedLocalKey,
  unexplainedProblems,
  useExtension,
  walletContext,
} from './ChromiumWorld.ts'
import { postJson, signedProfile, signedRequestAndProposal, until } from './EdgeWorld.ts'
import { pipeTo, upgradeStatus } from './PipeWorld.ts'

// The Nostr journeys of the native acceptance test (Runtime.native.test.ts), each against the edge at `url`: a
// person's key and wallet link in Chromium, and the relay pipe.

/** A person with a NIP-07 extension publishes a profile and links their wallet; the index shows it verified. */
export const linksWalletWithExtension = (url: string) =>
  Effect.gen(function* () {
    const person = yield* walletContext(yield* headlessChromium)
    const { pubkey } = yield* nostrExtension(person.context)
    const { page, problems, notFound } = yield* openPage(person.context, url)
    yield* useExtension(page, pubkey)

    const name = `Acceptance ${generatePrivateKey().slice(2, 10)}`
    yield* publishProfile(page, name)
    yield* Effect.promise(() => page.getByRole('definition').filter({ hasText: name }).waitFor({ timeout: 15000 }))

    yield* clickThenSee(page, 'Link your wallet', 'Your wallet is linked to your key.')
    const account = `eip155:5042002:${person.wallet.address.toLowerCase()}`
    const row = page.getByRole('list', { name: 'Linked wallets' }).getByRole('listitem').filter({ hasText: account })
    yield* Effect.promise(() => row.getByText('Verified', { exact: true }).waitFor({ timeout: 15000 }))
    const linked = yield* until(HttpClient.get(`${url}/api/wallets/${account}`), LinkedWallet)
    expect(linked).toMatchObject({ pubkey, verification: 'verified' })
    expect(yield* storedItems(page)).toEqual([['sidequest.signer', JSON.stringify({ signerKind: 'nip07', pubkey })]])
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
