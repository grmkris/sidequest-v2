import { type EventId, type PublicKey, publicKeyOf, type SecretKey } from '@sidequest/nostr'
import { deliveryNote, envelopeTag, jobAccept, jobProposal, jobRequest, statement } from '@sidequest/nostr/vocabulary'
import { AccountRef, type GrantScope, Terms, termsDigest, UsdcOnArcTestnet } from '@sidequest/protocol'
import { Effect, Schema } from 'effect'
import { describe, expect, test } from 'vitest'
import { CoreRefused } from '../src/Core/Core.ts'
import { agentLimits } from '../src/Mcp/Acting.ts'
import { connect, mcp, tool } from './Connect.ts'
import { eventsOfKind } from './CoreDouble.ts'
import { freshKey, type Gateway, signed, signedLater, withGateway } from './GatewayWorld.ts'

const now = () => Math.floor(Date.now() / 1000)
const day = 86_400
const wallet = Schema.decodeSync(AccountRef)(`${UsdcOnArcTestnet.network}:0x${'ab'.repeat(20)}`)

const terms = Schema.decodeSync(Terms)({
  title: 'A logo',
  deliverables: ['SVG logo'],
  amount: '250000000',
  asset: UsdcOnArcTestnet.id,
  network: UsdcOnArcTestnet.network,
  deliveryDeadline: now() + 30 * day,
  reviewWindowSeconds: 3 * day,
  disputeWindowSeconds: 2 * day,
  arbitrationWindowSeconds: 7 * day,
  rail: 'escrow',
})

/** An operator, their agent granted `scopes`, a connected client's token, and a buyer's open request. */
const setUp = async (gateway: Gateway, scopes: ReadonlyArray<GrantScope>) => {
  const operatorKey = freshKey()
  const operator = publicKeyOf(operatorKey)
  const agent = await gateway.createAgent(operatorKey)
  const grant = await gateway.grant(operatorKey, agent, scopes)
  gateway.core.wallets.set(operator, [wallet])
  const { tokens } = await connect(gateway, operatorKey, agent)
  const buyerKey = freshKey()
  const request = signed(jobRequest, { title: 'Logo', description: 'For a café', expiresAt: now() + 7 * day }, buyerKey)
  gateway.core.events.push(request)
  const call = (name: string, args: object = {}) => tool(gateway, tokens.access_token, name, args)
  return { operatorKey, operator, agent, grant, token: tokens.access_token, buyerKey, job: request.id, call }
}

/** A proposal by `key` on `job`, as a bidder's own signer makes it. */
const proposalBy = async (key: SecretKey, job: EventId, buyer: PublicKey) => {
  const digest = await Effect.runPromise(termsDigest(terms))
  return signedLater(
    jobProposal,
    {
      job,
      buyer,
      terms,
      termsDigest: digest,
      payTo: wallet,
      validUntil: now() + day,
    },
    key,
    UsdcOnArcTestnet.network,
  )
}

describe('the tools, against the core double', () => {
  test('whoami and the reads answer as the agent, under its grant', () =>
    withGateway(async (gateway) => {
      const { agent, operator, grant, job, call, buyerKey } = await setUp(gateway, ['discuss'])
      expect(await call('whoami')).toMatchObject({ ok: true, value: { agent, operator, grant: { event: grant.id } } })
      expect(await call('list_open_requests')).toMatchObject({ ok: true, value: { items: [{ job }] } })
      expect(await call('get_job', { job })).toMatchObject({ ok: true, value: { job: { job, stage: 'open' } } })
      expect(await call('get_person', { pubkey: operator })).toMatchObject({
        ok: true,
        value: { person: { wallets: [{ account: wallet }] } },
      })
      expect(await call('get_person', { pubkey: publicKeyOf(buyerKey) })).toMatchObject({
        ok: false,
        refusal: { reason: 'UnknownPerson' },
      })
      expect(await call('payment_status', { job })).toMatchObject({
        ok: true,
        value: { payment: { stage: 'Unfunded' } },
      })
      expect(await call('search_listings', { text: 'logo' })).toMatchObject({ ok: true, value: { items: [] } })
      expect(await call('get_job', { job: 'ff'.repeat(32) })).toMatchObject({
        ok: false,
        refusal: { reason: 'UnknownJob' },
      })
    }))

  test('propose signs a proposal with the agent’s key, naming its grant, paying the operator’s wallet', () =>
    withGateway(async (gateway) => {
      const { agent, grant, job, call } = await setUp(gateway, ['propose'])
      const proposed = await call('propose', { job, terms, validUntil: now() + day })
      expect(proposed).toMatchObject({ ok: true, value: { job, payTo: wallet, signedBy: agent, grant: grant.id } })
      const [published] = await eventsOfKind(gateway.core, jobProposal)
      expect(published?.event.pubkey).toBe(agent)
      expect(published?.event.tags).toContainEqual([envelopeTag.grant, grant.id])
      expect(published?.content).toMatchObject({ job, payTo: wallet })
      // A revision names the agent's own proposal as `previous`.
      const revised = await call('propose', { job, terms, validUntil: now() + 2 * day, previous: published?.event.id })
      expect(revised).toMatchObject({ ok: true })
      expect(await call('get_job', { job })).toMatchObject({ value: { job: { stage: 'proposed' } } })
    }))

  test('propose is refused without the scope, without a wallet on the network, and on the operator’s own request', () =>
    withGateway(async (gateway) => {
      const discussing = await setUp(gateway, ['discuss'])
      const asked = { job: discussing.job, terms, validUntil: now() + day }
      expect(await discussing.call('propose', asked)).toMatchObject({ ok: false, refusal: { reason: 'ScopeMissing' } })
      const proposing = await setUp(gateway, ['propose'])
      gateway.core.wallets.delete(proposing.operator)
      expect(await proposing.call('propose', { ...asked, job: proposing.job })).toMatchObject({
        refusal: { reason: 'NoWalletOnNetwork' },
      })
      const own = signed(
        jobRequest,
        { title: 'Mine', description: 'Mine', expiresAt: now() + day },
        proposing.operatorKey,
      )
      gateway.core.events.push(own)
      gateway.core.wallets.set(proposing.operator, [wallet])
      expect(await proposing.call('propose', { ...asked, job: own.id })).toMatchObject({
        refusal: { reason: 'OwnRequest' },
      })
      expect(gateway.core.events.filter(({ pubkey }) => pubkey === proposing.agent)).toEqual([])
    }))

  test('withdraw_proposal signs a statement about the agent’s own proposal only', () =>
    withGateway(async (gateway) => {
      const { job, call, buyerKey } = await setUp(gateway, ['propose'])
      await call('propose', { job, terms, validUntil: now() + day })
      const [own] = await eventsOfKind(gateway.core, jobProposal)
      const other = await proposalBy(freshKey(), job, publicKeyOf(buyerKey))
      gateway.core.events.push(other)
      expect(await call('withdraw_proposal', { job, proposal: other.id, text: 'no' })).toMatchObject({
        refusal: { reason: 'NotYourProposal' },
      })
      expect(await call('withdraw_proposal', { job, proposal: own?.event.id, text: 'Booked up' })).toMatchObject({
        ok: true,
      })
      expect(await eventsOfKind(gateway.core, statement)).toMatchObject([{ content: { type: 'withdraw_proposal' } }])
      const shown = await call('get_job', { job })
      expect(JSON.stringify(shown)).toContain('"withdrawn":true')
    }))

  test('accept signs an accept for the operator’s own request; the fold does not count it as the buyer’s', () =>
    withGateway(async (gateway) => {
      const { operatorKey, operator, call, job } = await setUp(gateway, ['accept'])
      const mine = signed(jobRequest, { title: 'Mine', description: 'Mine', expiresAt: now() + day }, operatorKey)
      const bid = await proposalBy(freshKey(), mine.id, operator)
      const elsewhere = await proposalBy(freshKey(), job, operator)
      gateway.core.events.push(mine, bid, elsewhere)
      expect(await call('accept', { job, proposal: elsewhere.id })).toMatchObject({
        refusal: { reason: 'NotTheBuyer' },
      })
      const accepted = await call('accept', { job: mine.id, proposal: bid.id })
      expect(accepted).toMatchObject({
        ok: true,
        value: { fold: { stage: 'proposed', fromBuyer: false, matchesProposal: true } },
      })
      const [published] = await eventsOfKind(gateway.core, jobAccept)
      expect(published?.envelope.network).toMatchObject({ value: UsdcOnArcTestnet.network })
    }))

  test('deliver is refused before funding, and after it publishes a note and answers the typed data to sign', () =>
    withGateway(async (gateway) => {
      const { agent, job, call } = await setUp(gateway, ['propose', 'deliver'])
      await call('propose', { job, terms, validUntil: now() + day })
      const [proposal] = await eventsOfKind(gateway.core, jobProposal)
      const deliveryHash = `0x${'cd'.repeat(32)}`
      expect(await call('deliver', { job, deliveryHash })).toMatchObject({ refusal: { reason: 'NotTheWorker' } })
      gateway.core.funded.set(job, proposal?.event.id ?? '')
      const delivered = await call('deliver', { job, deliveryHash, url: 'https://example.com/logo.svg' })
      expect(delivered).toMatchObject({
        ok: true,
        value: { signedBy: agent, onChain: { signer: 'operator-wallet', typedData: { message: { deliveryHash } } } },
      })
      expect(await eventsOfKind(gateway.core, deliveryNote)).toMatchObject([{ content: { deliveryHash } }])
    }))

  test('a core refusal comes back with the core’s own reason, and nothing is retried as success', () =>
    withGateway(async (gateway) => {
      const { job, call } = await setUp(gateway, ['propose'])
      gateway.core.nextPublish.refusal = new CoreRefused({ refusal: 'RateLimited' })
      expect(await call('propose', { job, terms, validUntil: now() + day })).toMatchObject({
        ok: false,
        refusal: { reason: 'CoreRefused', core: { refusal: 'RateLimited' } },
      })
    }))

  test('limits each agent’s writes per minute', () =>
    withGateway(async (gateway) => {
      const { job, call } = await setUp(gateway, ['propose'])
      for (let write = 0; write < agentLimits.writes.limit; write += 1)
        await call('withdraw_proposal', { job, proposal: 'ee'.repeat(32), text: 'x' })
      expect(await call('withdraw_proposal', { job, proposal: 'ee'.repeat(32), text: 'x' })).toMatchObject({
        refusal: { reason: 'RateLimited' },
      })
    }))

  test('a revoked grant refuses the next call; the tools list stays readable to the client', () =>
    withGateway(async (gateway) => {
      const { operatorKey, grant, token, call } = await setUp(gateway, ['discuss'])
      expect(await call('whoami')).toMatchObject({ ok: true })
      gateway.revoke(operatorKey, grant)
      expect(await call('whoami')).toMatchObject({ ok: false, refusal: { reason: 'GrantRevoked' } })
      expect((await mcp(gateway, token, 'tools/list')).status).toBe(200)
    }))
})
