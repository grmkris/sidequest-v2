import { expect } from 'bun:test'
import { finalizeEvent, httpAuthHeader, httpAuthTemplate, Entropy, type SecretKey } from '@sidequest/nostr'
import { Person, Terms, UsdcOnArcTestnet } from '@sidequest/protocol'
import { Effect, Schema } from 'effect'
import * as HttpClient from 'effect/http/HttpClient'
import type { Page } from 'playwright'
import { anyone, nostrPerson, sign } from '../../packages/server/rehearsal/Nostr.ts'
import {
  headlessChromium,
  nostrExtension,
  openPage,
  reopen,
  unexplainedProblems,
  useExtension,
  walletContext,
} from '../../packages/server/src/test/ChromiumWorld.ts'
import { until } from '../../packages/server/src/test/EdgeWorld.ts'

// The website's journeys on the agent gateway and the inbox, in Chromium, against the core and the gateway deployed
// together (Gateway.native.test.ts): the agents page reaches the gateway only through the edge's `/gateway` proxy,
// signing each request with the person's NIP-07 extension, and the inbox is worked out in the browser.

const now = () => Math.floor(Date.now() / 1000)
const entropy = () => Schema.decodeSync(Entropy)(crypto.getRandomValues(new Uint8Array(32)))

/** A GET through the edge's proxy with `key`'s NIP-98 authorization of exactly that URL, as the page makes it. */
const proxiedGet = async (url: string, path: string, key: SecretKey) => {
  const target = `${url}/gateway${path}`
  const authorization = httpAuthHeader(
    finalizeEvent(httpAuthTemplate({ url: target, method: 'GET' }, now()), key, entropy()),
  )
  const response = await fetch(target, { headers: { authorization } })
  const body: unknown = await response.json()
  return { status: response.status, body }
}

/** Press the button named `button`, then wait until the page says `text`. */
const pressThenSee = (page: Page, button: string, text: string) =>
  Effect.promise(async () => {
    await page.getByRole('button', { name: button }).click()
    await page.getByText(text).first().waitFor({ timeout: 20000 })
  })

/** A person whose browser's NIP-07 extension holds `key`, set up as their signer on the identity page. */
const personWith = (url: string, key: SecretKey, pubkey: string) =>
  Effect.gen(function* () {
    const person = yield* walletContext(yield* headlessChromium)
    yield* nostrExtension(person.context, { key })
    const opened = yield* openPage(person.context, url)
    yield* useExtension(opened.page, pubkey)
    return opened
  })

const Grants = Schema.Struct({ agents: Person.fields.agents })

/** The grants the index shows `pubkey` gave, once `done` holds. */
const grantsOf = (url: string, pubkey: string, done: (grants: typeof Grants.Type) => boolean) =>
  until(HttpClient.get(`${url}/api/people/${pubkey}`), Grants, done)

/**
 * A person creates an agent on the agents page (the gateway makes its key, the extension signs its grant), the index
 * shows the grant, they pause the agent's rooms (the gateway agrees, read through the proxy) and revoke the grant (the
 * index shows it revoked). The page shows the MCP URL of the stage's gateway.
 */
export const managesAnAgent = (url: string, gatewayUrl: string) =>
  Effect.gen(function* () {
    const operator = nostrPerson('operator')
    const { page, problems, notFound } = yield* personWith(url, operator.key, operator.pubkey)
    yield* reopen(page, `${url}/agents`)
    yield* Effect.promise(() => page.getByLabel('Agent name').fill('Scout'))
    yield* pressThenSee(page, 'Create agent', 'The agent is made and granted.')
    const granted = yield* grantsOf(url, operator.pubkey, ({ agents }) =>
      agents.some((grant) => grant.label === 'Scout' && grant.status === 'active'),
    )
    const agent = granted.agents.find((grant) => grant.label === 'Scout')?.agent ?? ''
    expect(granted.agents.find((grant) => grant.agent === agent)?.scopes).toEqual(['discuss', 'propose'])
    yield* Effect.promise(() => page.getByText('Granted', { exact: true }).waitFor({ timeout: 15000 }))

    yield* Effect.promise(() => page.getByRole('button', { name: 'Manage' }).click())
    expect(yield* Effect.promise(() => page.locator('#agent-mcp-url').innerText())).toBe(`${gatewayUrl}/mcp`)
    yield* pressThenSee(page, 'Pause its rooms', 'The agent’s rooms are paused.')
    const pause = yield* Effect.promise(() => proxiedGet(url, `/api/agents/${agent}/pause`, operator.key))
    expect(pause).toEqual({ status: 200, body: { agent, paused: true } })

    yield* pressThenSee(page, 'Revoke grant', 'The grant is revoked.')
    yield* grantsOf(url, operator.pubkey, ({ agents }) =>
      agents.some((grant) => grant.agent === agent && grant.status === 'revoked'),
    )
    expect(unexplainedProblems(problems, notFound, operator.pubkey)).toEqual([])
  })

/** The edge's proxy reaches the gateway's operator API and nothing else of it, and keeps the gateway's refusals. */
const proxyChecks = async (url: string) => {
  const bare = await fetch(`${url}/gateway/api/agents`)
  expect([bare.status, await bare.json()]).toEqual([401, { error: 'unauthorized', reason: 'missing' }])
  expect((await fetch(`${url}/gateway/mcp`, { method: 'POST', body: '{}' })).status).toBe(404)
  expect((await fetch(`${url}/gateway/status`)).status).toBe(404)
  const operator = nostrPerson('operator')
  expect(await proxiedGet(url, '/api/agents', operator.key)).toEqual({ status: 200, body: { items: [] } })
}

/** The proxy checks, as a test step. */
export const proxiesOnlyTheOperatorApi = (url: string) => Effect.promise(() => proxyChecks(url))

/** Escrow terms on Arc testnet for a logo, delivered within 30 days, as a proposal offers them. */
export const escrowTerms = (title: string) => ({
  title,
  deliverables: ['SVG logo'],
  amount: '250000000',
  asset: UsdcOnArcTestnet.id,
  network: UsdcOnArcTestnet.network,
  deliveryDeadline: now() + 30 * 86_400,
  reviewWindowSeconds: 3 * 86_400,
  disputeWindowSeconds: 2 * 86_400,
  arbitrationWindowSeconds: 7 * 86_400,
  rail: 'escrow' as const,
})
const offered = Schema.decodeUnknownSync(Terms)(escrowTerms('A logo for the inbox'))

/**
 * A buyer's inbox, worked out in their browser: a bidder proposes on their request (signed events through the index),
 * and the inbox shows it, marked new until the buyer marks it read, which this browser alone remembers.
 */
export const inboxShowsAProposal = (url: string) =>
  Effect.gen(function* () {
    const buyer = nostrPerson('buyer')
    const bidder = nostrPerson('bidder')
    const core = anyone(url)
    const request = yield* Effect.promise(() => sign.request(buyer, 'A logo for the inbox'))
    yield* Effect.promise(async () => {
      await core.publish(request)
      await core.publish(await sign.link(bidder))
      await core.publish(await sign.proposal(bidder, request, offered))
    })
    const { page, problems, notFound } = yield* personWith(url, buyer.key, buyer.pubkey)
    yield* reopen(page, `${url}/inbox`)
    const item = page
      .getByRole('list', { name: 'Inbox' })
      .getByRole('listitem')
      .filter({ hasText: 'proposed on “A logo for the inbox”' })
    yield* Effect.promise(() => item.waitFor({ timeout: 20000 }))
    expect(yield* Effect.promise(() => item.getByText('New', { exact: true }).count())).toBe(1)
    yield* Effect.promise(() => page.getByRole('button', { name: 'Mark all as read' }).click())
    yield* Effect.promise(() => item.getByText('New', { exact: true }).waitFor({ state: 'detached', timeout: 15000 }))
    yield* reopen(page, `${url}/inbox`)
    yield* Effect.promise(() => item.waitFor({ timeout: 20000 }))
    expect(yield* Effect.promise(() => item.getByText('New', { exact: true }).count())).toBe(0)
    expect(unexplainedProblems(problems, notFound, buyer.pubkey)).toEqual([])
  })
