import { expect } from 'bun:test'
import { Person } from '@sidequest/protocol'
import { Effect, Schema } from 'effect'
import * as HttpClient from 'effect/http/HttpClient'
import type { Page } from 'playwright'
import { generatePrivateKey } from 'viem/accounts'
import {
  headlessChromium,
  openPage,
  publishProfile,
  storedItems,
  unexplainedProblems,
  walletContext,
} from './ChromiumWorld.ts'
import { until } from './EdgeWorld.ts'

// The passkey journeys of the native acceptance test (Runtime.native.test.ts), against the edge at `url`, whose
// website offers passkeys for the relying party `localhost` (ADR-0005). Chromium's virtual authenticator, added over
// the DevTools protocol, stands in for a passkey provider: a resident key, user verification, and PRF or not.

/** A virtual authenticator in `page`'s tab: CTAP 2.1, internal, resident keys and user verification, PRF as asked;
 * it answers every prompt as if the person approved. */
export const virtualAuthenticator = (page: Page, hasPrf: boolean) =>
  Effect.promise(async () => {
    const devtools = await page.context().newCDPSession(page)
    await devtools.send('WebAuthn.enable', { enableUI: false })
    const { authenticatorId } = await devtools.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2',
        ctap2Version: 'ctap2_1',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        hasPrf,
        automaticPresenceSimulation: true,
      },
    })
    return {
      credentials: () =>
        devtools.send('WebAuthn.getCredentials', { authenticatorId }).then(({ credentials }) => credentials),
    }
  })

const StoredPasskey = Schema.fromJsonString(
  Schema.Struct({ signerKind: Schema.Literal('passkey'), pubkey: Schema.String, credentialId: Schema.String }),
)

/** What `localStorage` holds of a passkey key: exactly the signer (which, whose key, which credential), and whether
 * any value is another 64-hex value (a raw secret would be one), an `nsec` or an `ncryptsec`. */
const storedPasskey = (page: Page) =>
  Effect.gen(function* () {
    const items = yield* storedItems(page)
    const stored = yield* Schema.decodeUnknownEffect(Schema.Struct({ 'sidequest.signer': StoredPasskey }), {
      onExcessProperty: 'error',
    })(Object.fromEntries(items))
    const { pubkey, credentialId } = stored['sidequest.signer']
    const values = items.map(([, value]) => value).join('\n')
    return {
      pubkey,
      credentialId,
      otherHex: (values.match(/[0-9a-f]{64}/gu) ?? []).filter((hex) => hex !== pubkey),
      secretText: values.includes('nsec1') || values.includes('ncryptsec1'),
    }
  })

const click = (page: Page, button: string) =>
  Effect.promise(() => page.getByRole('button', { name: button, exact: true }).click())

const see = (page: Page, text: string) =>
  Effect.promise(() => page.getByText(text, { exact: false }).first().waitFor({ timeout: 15000 }))

/**
 * A person makes a key with a passkey, declines the backup by its own button, publishes a profile, and after a reload
 * unlocks the same key with the passkey; with the browser's storage wiped (as on a device that never saw the key),
 * "Use my passkey" finds the passkey and derives the same key. Storage never holds a secret.
 */
export const derivesKeyFromPasskey = (url: string) =>
  Effect.gen(function* () {
    const { context } = yield* walletContext(yield* headlessChromium)
    const { page, problems, notFound } = yield* openPage(context, `${url}/identity`)
    const authenticator = yield* virtualAuthenticator(page, true)
    yield* see(page, 'so make a key with a passkey')
    yield* click(page, 'Create a key with a passkey')
    yield* see(page, 'Your passkey made your key.')
    expect(yield* storedItems(page)).toEqual([])
    yield* click(page, 'Continue without a backup')
    yield* Effect.promise(() => page.getByLabel('Name', { exact: true }).waitFor({ timeout: 15000 }))

    const kept = yield* storedPasskey(page)
    expect(kept).toMatchObject({ otherHex: [], secretText: false })
    const [credential] = yield* Effect.promise(() => authenticator.credentials())
    expect(credential).toMatchObject({ isResidentCredential: true, rpId: 'localhost' })
    // DevTools gives the id in base64, the browser's `rawId` (which the page keeps) in base64url.
    const exported = (credential?.credentialId ?? '').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
    expect(kept.credentialId).toBe(exported)

    const name = `Passkey ${generatePrivateKey().slice(2, 10)}`
    yield* publishProfile(page, name)
    const indexed = yield* until(HttpClient.get(`${url}/api/people/${kept.pubkey}`), Person)
    expect(indexed.profile).toMatchObject({ name })

    // A reload: the key is gone from memory and comes back only through the passkey.
    yield* Effect.promise(() => page.reload({ waitUntil: 'networkidle' }))
    yield* click(page, 'Unlock with your passkey')
    yield* see(page, kept.pubkey)
    expect(yield* storedPasskey(page)).toEqual(kept)

    // Storage wiped, as a browser that never had the key: the passkey alone gives it back.
    yield* Effect.promise(() => page.evaluate(() => window.localStorage.clear()))
    yield* Effect.promise(() => page.reload({ waitUntil: 'networkidle' }))
    yield* click(page, 'Use my passkey')
    yield* see(page, kept.pubkey)
    expect(yield* storedPasskey(page)).toEqual(kept)
    expect(unexplainedProblems(problems, notFound, kept.pubkey)).toEqual([])
  })

/** A person whose passkey provider has no PRF is told so, plainly, and offered the in-browser key instead; nothing is
 * kept. */
export const fallsBackWithoutPrf = (url: string) =>
  Effect.gen(function* () {
    const { context } = yield* walletContext(yield* headlessChromium)
    const { page, problems } = yield* openPage(context, `${url}/identity`)
    yield* virtualAuthenticator(page, false)
    yield* click(page, 'Create a key with a passkey')
    yield* see(page, 'cannot make a key from a passkey: it lacks the PRF extension')
    expect(yield* Effect.promise(() => page.getByRole('button', { name: 'Create a key with a passkey' }).count())).toBe(
      0,
    )
    expect(yield* Effect.promise(() => page.getByRole('button', { name: 'Use my passkey' }).count())).toBe(0)
    yield* Effect.promise(() =>
      page.getByRole('button', { name: 'Create a key in this browser' }).waitFor({ timeout: 15000 }),
    )
    expect(yield* storedItems(page)).toEqual([])
    expect(problems).toEqual([])
  })
