import { Entropy, type EventTemplate, finalizeEvent, publicKeyOf, SecretKey } from '@sidequest/nostr'
import { Effect, Schema } from 'effect'
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright'
import { isHex } from 'viem'
import { generatePrivateKey, type PrivateKeyAccount, privateKeyToAccount } from 'viem/accounts'

// A real browser against the deployed edge, for the native acceptance tests: headless Chromium, a context whose page
// has a wallet, and pages that report every error and wait until Foldkit hydrated them.

/** A headless Chromium for one test, closed when the test's scope ends. */
export const headlessChromium = Effect.acquireRelease(
  Effect.promise(() => chromium.launch({ headless: true })),
  (opened) => Effect.promise(() => opened.close()),
)

/** `eth_signTypedData_v4` as wallets take it: the typed data as JSON, its `EIP712Domain` type included, which viem
 * derives itself. */
const signTypedDataJson = (wallet: PrivateKeyAccount, json: unknown) => {
  const { domain, types, primaryType, message } = Schema.decodeUnknownSync(TypedDataJson)(json)
  const { EIP712Domain: _derivedByViem, ...structs } = types
  return wallet.signTypedData({ domain, types: structs, primaryType, message })
}

/** A browser context whose page has a wallet: `window.ethereum`, an EIP-1193 provider backed by a key in this process.
 * The page's CSP forbids inline script, so the provider is installed with Playwright's init script, which the browser
 * evaluates outside the page's CSP, and each request crosses to Node through an exposed function. */
export const walletContext = (browser: Browser) =>
  Effect.gen(function* () {
    const wallet = privateKeyToAccount(generatePrivateKey())
    const context = yield* Effect.promise(() => browser.newContext({ locale: 'en-US' }))
    yield* Effect.promise(() =>
      context.exposeFunction('__sidequestWallet', async (method: string, params: ReadonlyArray<unknown>) => {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [wallet.address]
        if (method === 'eth_chainId') return '0x4cef52'
        const [message, typedData] = params
        if (method === 'personal_sign' && typeof message === 'string' && isHex(message))
          return wallet.signMessage({ message: { raw: message } })
        if (method === 'eth_signTypedData_v4') return signTypedDataJson(wallet, typedData)
        throw Object.assign(new Error(`The test wallet does not answer ${method}`), { code: 4200 })
      }),
    )
    yield* Effect.promise(() =>
      context.addInitScript({
        content:
          'window.ethereum = { request: ({ method, params }) => window.__sidequestWallet(method, params ?? []) }',
      }),
    )
    return { wallet, context }
  })

const TypedDataJson = Schema.fromJsonString(
  Schema.Struct({
    domain: Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number])),
    types: Schema.Record(Schema.String, Schema.Array(Schema.Struct({ name: Schema.String, type: Schema.String }))),
    primaryType: Schema.String,
    message: Schema.Record(Schema.String, Schema.String),
  }),
)

const EventTemplateJson = Schema.Struct({
  created_at: Schema.Int,
  kind: Schema.Int,
  tags: Schema.Array(Schema.Array(Schema.String)),
  content: Schema.String,
})

/** A NIP-07 extension in the context's pages: `window.nostr`, backed by a key in this process, installed like the
 * wallet. It signs whatever it is asked to, as a real extension does once the person approved. */
export const nostrExtension = (context: BrowserContext) =>
  Effect.gen(function* () {
    const key = yield* Schema.decodeEffect(SecretKey)(generatePrivateKey().slice(2))
    const auxRand = yield* Schema.decodeEffect(Entropy)(new Uint8Array(32))
    yield* Effect.promise(() =>
      context.exposeFunction('__sidequestNostr', async (method: string, event: unknown) => {
        if (method === 'getPublicKey') return publicKeyOf(key)
        const template: EventTemplate = Schema.decodeUnknownSync(EventTemplateJson)(event)
        return finalizeEvent(template, key, auxRand)
      }),
    )
    yield* Effect.promise(() =>
      context.addInitScript({
        content:
          "window.nostr = { getPublicKey: () => window.__sidequestNostr('getPublicKey'), signEvent: (event) => window.__sidequestNostr('signEvent', event) }",
      }),
    )
    return { pubkey: publicKeyOf(key) }
  })

/** Wait until Foldkit adopted the server-rendered root, which it marks by removing the root's stamp. */
const hydrated = (page: Page) =>
  Effect.promise(() =>
    page.waitForFunction(() => window.document.querySelector('[data-foldkit-app]') === null, undefined, {
      timeout: 10000,
    }),
  )

/** A page that records every error the browser reports, CSP violations included, and every 404 it met, and is
 * hydrated before use. */
export const openPage = (context: BrowserContext, url: string) =>
  Effect.gen(function* () {
    const page = yield* Effect.promise(() => context.newPage())
    const problems: Array<string> = []
    page.on('pageerror', (error) => problems.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') problems.push(message.text())
    })
    // The paths it asked for and got 404 for, which the browser also logs as errors.
    const notFound: Array<string> = []
    page.on('response', (response) => {
      if (response.status() === 404) notFound.push(new URL(response.url()).pathname)
    })
    yield* Effect.promise(() => page.goto(url, { waitUntil: 'networkidle' }))
    yield* hydrated(page)
    return { page, problems, notFound }
  })

/** Open `target` in `page` and wait until it hydrated; the paths of the API reads the page made meanwhile, data or
 * session alike. A page hydrated from the server's data makes none of the reads it rendered. */
export const apiReadsDuring = (page: Page, target: string) =>
  Effect.gen(function* () {
    const reads: Array<string> = []
    const record = (request: { readonly method: () => string; readonly url: () => string }) => {
      const path = new URL(request.url()).pathname
      if (request.method() === 'GET' && path.startsWith('/api/')) reads.push(path)
    }
    page.on('request', record)
    yield* Effect.promise(() => page.goto(target, { waitUntil: 'networkidle' }))
    yield* hydrated(page)
    page.off('request', record)
    return reads
  })

/** Reload until `text` shows: the open requests come from a D1 projection, which follows the job eventually. A bounded
 * retry on what the page shows, never a fixed sleep. */
export const reloadUntilShown = (page: Page, text: string) =>
  Effect.tryPromise(async () => {
    await page.reload({ waitUntil: 'networkidle' })
    await page.getByText(text).first().waitFor({ timeout: 1000 })
  }).pipe(Effect.retry({ times: 20 }))

/** Everything the page's origin keeps in `localStorage`. */
export const storedItems = (page: Page) =>
  Effect.promise(() =>
    page.evaluate(() =>
      Object.keys(window.localStorage).map((key): [string, string] => [key, window.localStorage.getItem(key) ?? '']),
    ),
  )

/** The identity page, reached from the header, uses the browser's NIP-07 extension, and shows its key. */
export const useExtension = (page: Page, pubkey: string) =>
  Effect.gen(function* () {
    yield* Effect.promise(() => page.getByRole('link', { name: 'Identity' }).click())
    yield* Effect.promise(() => page.getByRole('button', { name: 'Use the Nostr extension' }).click())
    yield* Effect.promise(() => page.getByText(pubkey).waitFor({ timeout: 15000 }))
  })

/** Press the button named `button`, then wait until the page says `text`. */
export const clickThenSee = (page: Page, button: string, text: string) =>
  Effect.gen(function* () {
    yield* Effect.promise(() => page.getByRole('button', { name: button }).click())
    yield* Effect.promise(() => page.getByText(text).waitFor({ timeout: 15000 }))
  })

/** The person confirms they saved the new key's backup, and the identity page goes on to the profile. */
export const confirmBackup = (page: Page) =>
  Effect.gen(function* () {
    yield* Effect.promise(() => page.getByLabel('I saved my backup somewhere safe').check())
    yield* Effect.promise(() => page.getByRole('button', { name: 'Continue' }).click())
    yield* Effect.promise(() => page.getByLabel('Name', { exact: true }).waitFor({ timeout: 15000 }))
  })

/** The identity page makes a key in the browser under `password`; the backup it shows once scrypt is done. */
export const createLocalKey = (page: Page, password: string) =>
  Effect.gen(function* () {
    yield* Effect.promise(() => page.getByRole('button', { name: 'Create a key in this browser' }).click())
    yield* Effect.promise(() => page.getByLabel('Password', { exact: true }).fill(password))
    yield* Effect.promise(() => page.getByLabel('Password again').fill(password))
    yield* Effect.promise(() => page.getByRole('button', { name: 'Create key' }).click())
    // scrypt at log_n 16 runs in the page.
    const backup = page.locator('#signer-backup')
    yield* Effect.promise(() => backup.waitFor({ timeout: 30000 }))
    return yield* Effect.promise(() => backup.innerText())
  })

/** The identity page publishes a profile with `name`, and says so. */
export const publishProfile = (page: Page, name: string) =>
  Effect.gen(function* () {
    yield* Effect.promise(() => page.getByLabel('Name', { exact: true }).fill(name, { timeout: 30000 }))
    yield* Effect.promise(() => page.getByRole('button', { name: 'Publish profile' }).click())
    yield* Effect.promise(() => page.getByText('Your profile is published.').waitFor({ timeout: 15000 }))
  })

const StoredIdentity = Schema.fromJsonString(
  Schema.Struct({ signerKind: Schema.Literal('local'), pubkey: Schema.String }),
)

/** What `localStorage` holds of a local key: whose key, its ciphertext, any other 64-hex value it keeps (a raw secret
 * would be one), and whether anything is an `nsec`. Fails unless it holds exactly the signer and the ciphertext. */
export const storedLocalKey = (page: Page) =>
  Effect.gen(function* () {
    const items = yield* storedItems(page)
    const stored = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ 'sidequest.signer': StoredIdentity, 'sidequest.signer.ncryptsec': Schema.String }),
      { onExcessProperty: 'error' },
    )(Object.fromEntries(items))
    const { pubkey } = stored['sidequest.signer']
    const values = items.map(([, value]) => value).join('\n')
    return {
      pubkey,
      ncryptsec: stored['sidequest.signer.ncryptsec'],
      otherHex: (values.match(/[0-9a-f]{64}/gu) ?? []).filter((hex) => hex !== pubkey),
      nsec: values.includes('nsec1'),
    }
  })

/** Reload the identity page, which then waits locked, and unlock the key with its password. */
export const reloadThenUnlock = (page: Page, password: string) =>
  Effect.gen(function* () {
    yield* Effect.promise(() => page.reload({ waitUntil: 'networkidle' }))
    yield* Effect.promise(() => page.getByRole('button', { name: 'Unlock' }).waitFor({ timeout: 15000 }))
    yield* Effect.promise(() => page.getByLabel('Password', { exact: true }).fill(password))
    yield* Effect.promise(() => page.getByRole('button', { name: 'Unlock' }).click())
  })

/**
 * The browser's errors, less those of reading a key the index has not seen yet: the identity page reads what the
 * index knows of a key as soon as it has one, and the index answers 404 for a key it knows nothing of, which the
 * browser logs. Any other 404, or any other error, stays.
 */
export const unexplainedProblems = (
  problems: ReadonlyArray<string>,
  notFound: ReadonlyArray<string>,
  pubkey: string,
) => {
  const unknownKey = notFound.filter((path) => path === `/api/people/${pubkey}`).length
  const logged = 'Failed to load resource: the server responded with a status of 404 (Not Found)'
  const others = problems.filter((problem) => problem !== logged)
  const missing = problems.length - others.length
  return [
    ...others,
    ...(missing === unknownKey && missing === notFound.length
      ? []
      : [`${missing} logged 404s for ${notFound.join(', ')}`]),
  ]
}
