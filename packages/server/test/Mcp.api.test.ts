import { JobId, ListingId, roomIdOf } from '@sidequest/protocol'
import { Schema } from 'effect'
import { describe, expect, test } from 'vitest'
import {
  artifactHash,
  buyerViewOf,
  named,
  postJob,
  propose,
  recordDelivery,
  recordFunding,
  recordSettlement,
} from './Hire.ts'
import { ada, ben, cy, inSeconds, origin, request, terms, withApi } from './HttpWorld.ts'
import { callTool, grantedAgent, refusalOf, rpc, untilTool } from './McpWorld.ts'

// The MCP tools as an agent calls them over HTTP, with hand-written JSON-RPC: each is the HTTP API's command or read
// as the agent, so the model's rules judge it, and its refusals carry the HTTP API's reason and evidence.

const Tools = Schema.Struct({
  result: Schema.Struct({
    tools: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        description: Schema.String,
        inputSchema: Schema.Unknown,
        outputSchema: Schema.Unknown,
        annotations: Schema.Struct({
          readOnlyHint: Schema.Boolean,
          destructiveHint: Schema.Boolean,
          idempotentHint: Schema.Boolean,
          openWorldHint: Schema.Boolean,
        }),
      }),
    ),
  }),
})

const reads = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
const writes = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }

/** A tool result's structured content as `schema` reads it. */
const structured = <A>(schema: Schema.Decoder<A>, result: { readonly structuredContent?: unknown }) =>
  Schema.decodeUnknownSync(schema)(result.structuredContent)

describe('the MCP tools', () => {
  test('are listed with their hints, strict input schemas and output schemas', () =>
    withApi(async (api) => {
      const { token } = await grantedAgent(await api.signIn(ada), ['discuss'])
      const listed = Schema.decodeUnknownSync(Tools)((await rpc(api, token, 'tools/list')).message).result.tools
      expect(Object.fromEntries(listed.map(({ name, annotations }) => [name, annotations]))).toEqual({
        whoami: reads,
        list_inbox: reads,
        find: reads,
        get_listing: reads,
        publish_listing: writes,
        list_open_requests: reads,
        post_request: writes,
        get_job: reads,
        propose: writes,
        request_change: writes,
        accept: { ...writes, destructiveHint: true },
        deliver: writes,
        review: writes,
        payment_status: reads,
        list_rooms: reads,
        get_room: reads,
        send_message: { ...writes, idempotentHint: true },
      })
      for (const { inputSchema } of listed) expect(inputSchema).toMatchObject({ additionalProperties: false })
      await expect(`${JSON.stringify(listed, null, 2)}\n`).toMatchFileSnapshot('./__snapshots__/McpTools.snap')
    }))

  test('let a seller’s agent publish a listing, find it and read it', () =>
    withApi(async (api) => {
      const seller = await api.signIn(ben)
      const { token } = await grantedAgent(seller, ['propose'])
      const details = { title: 'Logos', description: 'Hand-drawn logos.', tags: ['logo', 'brand'] }
      const published = await callTool(api, token, 'publish_listing', details)
      const { listing } = structured(Schema.Struct({ listing: ListingId }), published)
      const found = await untilTool(
        () => callTool(api, token, 'find', { text: 'logo', limit: 5 }),
        (result) => JSON.stringify(result.structuredContent).includes(listing),
      )
      expect(found.structuredContent).toEqual({
        items: [{ id: listing, owner: seller.account, ...details, state: 'published' }],
        next: null,
      })
      expect((await callTool(api, token, 'get_listing', { listing })).structuredContent).toEqual({
        listing: { id: listing, owner: seller.account, ...details, state: 'published' },
      })
      const unknown = 'listing_01JCXZ4Q6N8M2V7T3R5W9Y0B1Z'
      expect(refusalOf(await callTool(api, token, 'get_listing', { listing: unknown }))).toEqual({
        _tag: 'NotFound',
        reason: 'UnknownListing',
        evidence: { listing: unknown },
      })
    }))

  test(
    'let a buyer’s agent post, read, ask for a change and accept, pointing the person at each step of theirs',
    () =>
      withApi(async (api) => {
        const buyer = await api.signIn(ada)
        const worker = await api.signIn(ben)
        const { token } = await grantedAgent(buyer, ['discuss', 'accept'])
        const posted = await callTool(api, token, 'post_request', request())
        const { job } = structured(Schema.Struct({ job: JobId }), posted)
        await untilTool(
          () => callTool(api, token, 'list_open_requests', {}),
          (result) => JSON.stringify(result.structuredContent).includes(job),
        )
        await propose(worker, job)
        const [v1] = (await buyerViewOf(buyer, job, (view) => view.proposals.length === 1)).proposals
        if (v1 === undefined) throw new Error('No proposal arrived')
        expect((await callTool(api, token, 'get_job', { job })).structuredContent).toMatchObject({
          job: { audience: 'buyer', view: { state: 'Open', proposals: [{ bidder: worker.account, version: 1 }] } },
          nextAction: null,
        })
        expect((await callTool(api, token, 'request_change', { job, ...named(v1) })).structuredContent).toEqual({
          job,
          nextAction: null,
        })
        await propose(worker, job, 1, terms('300000000'))
        const [, v2] = (await buyerViewOf(buyer, job, (view) => view.proposals.length === 2)).proposals
        if (v2 === undefined) throw new Error('Version 2 did not arrive')
        const fund = { kind: 'fund_escrow', actor: 'person', url: `${origin}/jobs/${job}` }
        expect((await callTool(api, token, 'accept', { job, ...named(v2) })).structuredContent).toMatchObject({
          job,
          nextAction: fund,
        })
        const awarded = await buyerViewOf(buyer, job, (view) => view.state === 'Awarded')
        expect((await callTool(api, token, 'get_job', { job })).structuredContent).toMatchObject({ nextAction: fund })
        // No escrow is configured in this world: the payment's status is unavailable, and says so as a tool error.
        expect(refusalOf(await callTool(api, token, 'payment_status', { job }))).toEqual({ _tag: 'Unavailable' })
        const inbox = await untilTool(
          () => callTool(api, token, 'list_inbox', { limit: 10 }),
          (result) => JSON.stringify(result.structuredContent).split('proposal_submitted').length === 3,
        )
        expect(inbox.structuredContent).toMatchObject({ more: false })
        if (awarded.agreement === null) throw new Error('No agreement')
        await recordFunding(api, awarded.agreement)
        await buyerViewOf(buyer, job, (view) => view.state === 'Funded')
        await worker.post(`/api/jobs/${job}/delivery`, { artifactHash, url: 'https://files.example/logo.zip' })
        await recordDelivery(api, job)
        await buyerViewOf(buyer, job, (view) => view.state === 'Delivered')
        expect((await callTool(api, token, 'get_job', { job })).structuredContent).toMatchObject({
          nextAction: { kind: 'review_delivery', url: `${origin}/jobs/${job}` },
        })
        await recordSettlement(api, awarded.agreement)
        await buyerViewOf(buyer, job, (view) => view.state === 'Settled')
        const review = { job, rating: 5, comment: 'Lovely work.' }
        expect((await callTool(api, token, 'review', review)).structuredContent).toEqual({ job, nextAction: null })
        expect(refusalOf(await callTool(api, token, 'review', review))).toMatchObject({
          _tag: 'Conflict',
          reason: 'AlreadyReviewed',
        })
      }),
    20_000,
  )

  test('refuse what the grant does not cover and what the model refuses, with the HTTP API’s reason and evidence', () =>
    withApi(async (api) => {
      const buyer = await api.signIn(ada)
      const stranger = await api.signIn(cy)
      const { agent, token } = await grantedAgent(buyer, ['discuss'])
      const job = await postJob(buyer)
      expect(refusalOf(await callTool(api, token, 'propose', { job, terms: terms() }))).toEqual({
        _tag: 'Forbidden',
        reason: 'MissingScope',
        evidence: { agent, scope: 'propose' },
      })
      const proposer = await grantedAgent(buyer, ['propose'])
      expect(refusalOf(await callTool(api, proposer.token, 'propose', { job, terms: terms() }))).toEqual({
        _tag: 'Forbidden',
        reason: 'SelfBid',
        evidence: { bidder: buyer.account },
      })
      const outsider = await grantedAgent(stranger, ['accept'])
      expect(
        refusalOf(
          await callTool(api, outsider.token, 'accept', {
            job,
            bidder: buyer.account,
            version: 1,
            termsDigest: artifactHash,
          }),
        ),
      ).toEqual({
        _tag: 'Forbidden',
        reason: 'NotPermitted',
        evidence: { account: stranger.account, required: 'buyer' },
      })
      expect(refusalOf(await callTool(api, outsider.token, 'payment_status', { job }))).toMatchObject({
        _tag: 'Conflict',
        reason: 'WrongState',
      })
      const later = inSeconds(3600)
      expect(refusalOf(await callTool(api, token, 'post_request', { ...request(), expiresAt: 1 }))).toMatchObject({
        _tag: 'Unprocessable',
        reason: 'ExpiryNotInFuture',
      })
      expect((await callTool(api, token, 'post_request', { ...request(), expiresAt: later })).isError).toBe(false)
    }))

  test('answer an unknown tool with a JSON-RPC error, and arguments outside the schema with a tool error', () =>
    withApi(async (api) => {
      const { token } = await grantedAgent(await api.signIn(ada), ['discuss'])
      const unknown = await rpc(api, token, 'tools/call', { name: 'pay', arguments: {} })
      expect(unknown.message).toMatchObject({ error: { code: -32602, message: "Tool 'pay' not found" } })
      // MCP reports invalid arguments as a tool error, so the model can read what to correct and call again.
      const invalid = async (name: string, args: Record<string, unknown>) => {
        const result = await callTool(api, token, name, args)
        expect(result.isError).toBe(true)
        return result.content[0]?.text
      }
      expect(await invalid('get_job', { job: 'job_nope' })).toMatch(/^Invalid parameters for tool 'get_job'.*\^job_/s)
      expect(await invalid('get_job', { job: 'job_01JCXZ4Q6N8M2V7T3R5W9Y0B1Z', extra: true })).toContain(
        'Expected no excess property',
      )
      expect(await invalid('find', { limit: 51 })).toContain('Expected a value between 1 and 50')
    }))

  test('refuse an agent’s message while its operator paused agents, and the seventh agent message in a row', () =>
    withApi(async (api) => {
      const buyer = await api.signIn(ada)
      const worker = await api.signIn(ben)
      const { agent, token } = await grantedAgent(worker, ['discuss'])
      const job = await postJob(buyer)
      await propose(worker, job)
      const room = roomIdOf({ job, kind: 'negotiation', bidder: worker.account })
      const say = (key: string) => callTool(api, token, 'send_message', { room, text: `Note ${key}`, key })
      await untilTool(
        () => say('1'),
        (result) => result.isError === false,
      )
      expect((await worker.post(`/api/rooms/${room}/pause`)).status).toBe(204)
      expect(refusalOf(await say('2'))).toEqual({
        _tag: 'Forbidden',
        reason: 'AgentPaused',
        evidence: { agent, member: worker.account },
      })
      expect((await worker.post(`/api/rooms/${room}/resume`)).status).toBe(204)
      for (const key of ['2', '3', '4', '5', '6']) expect((await say(key)).isError).toBe(false)
      expect(refusalOf(await say('7'))).toEqual({
        _tag: 'Conflict',
        reason: 'AgentTurnLimit',
        evidence: { consecutive: 6, limit: 6 },
      })
      // Retrying a message already posted is still a no-op, and a person speaking lets agents talk again.
      expect((await say('6')).isError).toBe(false)
      expect((await buyer.post(`/api/rooms/${room}/messages`, { text: 'Hello!', key: 'ada-1' })).status).toBe(204)
      expect((await say('7')).isError).toBe(false)
    }))
})
