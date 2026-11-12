import { Effect } from 'effect'
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright'
import { isHex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

// A real browser against the deployed edge, for the native acceptance tests: headless Chromium, a context whose page
// has a wallet, and pages that report every error and wait until Foldkit hydrated them.

/** A headless Chromium for one test, closed when the test's scope ends. */
export const headlessChromium = Effect.acquireRelease(
  Effect.promise(() => chromium.launch({ headless: true })),
  (opened) => Effect.promise(() => opened.close()),
)

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
        const [message] = params
        if (method === 'personal_sign' && typeof message === 'string' && isHex(message))
          return wallet.signMessage({ message: { raw: message } })
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

/** Wait until Foldkit adopted the server-rendered root, which it marks by removing the root's stamp. */
const hydrated = (page: Page) =>
  Effect.promise(() =>
    page.waitForFunction(() => window.document.querySelector('[data-foldkit-app]') === null, undefined, {
      timeout: 10000,
    }),
  )

/** A page that records every error the browser reports, CSP violations included, and is hydrated before use. */
export const openPage = (context: BrowserContext, url: string) =>
  Effect.gen(function* () {
    const page = yield* Effect.promise(() => context.newPage())
    const problems: Array<string> = []
    page.on('pageerror', (error) => problems.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') problems.push(message.text())
    })
    yield* Effect.promise(() => page.goto(url, { waitUntil: 'networkidle' }))
    yield* hydrated(page)
    return { page, problems }
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
