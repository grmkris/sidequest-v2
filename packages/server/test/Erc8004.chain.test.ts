import { type NostrEvent, publicKeyOf, type SecretKey } from '@sidequest/nostr'
import { agentGrant, buildSidequestEvent, erc8004Claim, jobReview, type KindSpec } from '@sidequest/nostr/vocabulary'
import {
  EscrowFunding,
  Erc8004FeedbackCall,
  Erc8004RegistrationCall,
  Erc8004RegistrationFile,
  Person,
  Relayed,
  type SidequestFeedbackEntry,
  SidequestFeedbackFile,
  SidequestRegistrationFile,
  TypedData,
} from '@sidequest/protocol'
import { erc8004IdentityAbi, erc8004ReputationAbi } from '@sidequest/settlement/abi/Erc8004'
import { ChainRpc } from '@sidequest/settlement/ChainRpc'
import { Effect, Layer, Option, Result, Schema } from 'effect'
import { decodeEventLog, isHex, keccak256, stringToHex, type TransactionReceipt } from 'viem'
import type { PrivateKeyAccount } from 'viem/accounts'
import { beforeEach, describe, expect, test } from 'vitest'
import { signTyped } from '../rehearsal/Surfaces.ts'
import { Erc8004Reader } from '../src/Erc8004/Erc8004Reader.ts'
import { entryDocument, entryHash, isoSeconds } from '../src/Erc8004/Feedback.ts'
import { verifyFeedbackFile } from '../src/Erc8004/FeedbackVerifier.ts'
import { ChainLogPoller } from '../src/Index/ChainLogPoller.ts'
import { Moderation } from '../src/Index/Moderation.ts'
import { type LocalChain, skipOnChain, suiteChain } from './Anvil.ts'
import { type Api, json, post, withApi } from './HttpWorld.ts'
import { accountOf, alice, bob, carol, linked, signed, walletOne, walletTwo } from './IndexWorld.ts'
import { proposalBy, requestBy, termsFrom } from './JobWorld.ts'
import { serverWorld } from './World.ts'

// ERC-8004 end to end on Anvil (ADR-0007), the registries at their Arc testnet addresses (see Anvil.ts). Alice buys
// with wallet one; Bob operates the agent Carol and is paid to wallet two. Carol proposes under Bob's grant, Alice funds,
// Bob's wallet delivers, Alice's approves: settled on chain and read into the index by the chain log poller. Both
// review. Bob's wallet registers Carol on the identity registry with the `agentURI` the API prepares, Bob publishes the
// claim, the token reader reads the chain, and Carol's identity verifies. Alice's review of Bob is in Carol's feedback
// file; a third party checks every entry from the file and the chain alone; Alice's wallet posts it on chain, and it
// reads back with the hash of the document the API serves.

const amount = 120_000_000n
const identityRegistry = 'eip155:5042002:0x8004a818bfb912233c491871b3d84c89a494bd9e'

const event = <C>(spec: KindSpec<C>, content: unknown, key: SecretKey, createdAt: number) =>
  Effect.runPromise(
    Schema.decodeUnknownEffect(spec.content)(content).pipe(
      Effect.flatMap((decoded) => buildSidequestEvent(spec, decoded, { createdAt })),
      Effect.map((template) => signed(template, key)),
    ),
  )

const relayed = async (chain: LocalChain, response: Response) => {
  const { transactionHash } = await json(Relayed, response)
  if (!isHex(transactionHash)) throw new Error('No transaction hash')
  expect((await chain.client.waitForTransactionReceipt({ hash: transactionHash })).status).toBe('success')
}

/** The token a registration minted: the identity registry's `Transfer` from nobody. */
const mintedId = (receipt: TransactionReceipt) => {
  for (const log of receipt.logs) {
    const decoded = decodeEventLog({ abi: erc8004IdentityAbi, data: log.data, topics: log.topics, strict: false })
    if (decoded.eventName === 'Transfer' && decoded.args.tokenId !== undefined) return decoded.args.tokenId
  }
  throw new Error('Nothing minted')
}

describe.skipIf(skipOnChain)('ERC-8004 on chain', () => {
  const chainOf = suiteChain('ERC-8004 on chain')
  let chain: LocalChain
  beforeEach(() => {
    chain = chainOf()
  })

  /** The API on a fresh database, settling on this suite's chain. */
  const settlingOn = (run: Parameters<typeof withApi>[0]) =>
    withApi(run, serverWorld(chain.client, { escrow: Option.some(chain.config) }).layer)

  const pollChain = (api: Api) =>
    api.run(
      Effect.flatMap(ChainLogPoller, (poller) => poller.run).pipe(
        Effect.provide(
          ChainLogPoller.layer(chain.chain, Option.some(0n)).pipe(Layer.provide(Layer.succeed(ChainRpc, chain.client))),
        ),
      ),
    )

  /** `wallet` signs the typed data the API serves at `path` (with `query`) and posts it there with `body`. */
  const signAndPost = async (
    api: Api,
    wallet: PrivateKeyAccount,
    path: string,
    query = '',
    body: Record<string, string> = {},
  ) => {
    const typed = await json(TypedData, await api.fetch(`${path}${query}`))
    await relayed(chain, await post(api, path, { ...body, signature: await signTyped(wallet, typed) }))
  }

  /** Carol proposes under Bob's grant; Alice funds; Bob's wallet delivers; Alice's approves; both review. */
  const settledHire = async (api: Api) => {
    const at = Math.floor(Date.now() / 1000)
    const grant = await event(
      agentGrant,
      {
        agent: publicKeyOf(carol),
        scopes: ['propose', 'deliver'],
        notBefore: at - 60,
        expiresAt: at + 86_400,
        label: 'Translator',
      },
      bob,
      at - 60,
    )
    const request = await requestBy(alice, at)
    const proposal = await proposalBy(carol, request, at + 1, termsFrom(at, String(amount)), accountOf(walletTwo), {
      grant: grant.id,
    })
    for (const published of [
      await linked(alice, walletOne, at),
      await linked(bob, walletTwo, at),
      grant,
      request,
      proposal,
    ])
      expect((await post(api, '/api/events', published)).status).toBe(200)
    await chain.mint(walletOne.address, amount)
    const funding = `/api/index/jobs/${request.id}/proposals/${proposal.id}/funding`
    const quote = await json(EscrowFunding, await api.fetch(`${funding}?payer=${walletOne.address}`))
    await relayed(
      chain,
      await post(api, funding, { payer: walletOne.address, signature: await signTyped(walletOne, quote.typedData) }),
    )
    await pollChain(api)
    const deliveryHash = `0x${'de'.repeat(32)}`
    await signAndPost(api, walletTwo, `/api/index/jobs/${request.id}/delivery`, `?deliveryHash=${deliveryHash}`, {
      deliveryHash,
    })
    await pollChain(api)
    await signAndPost(api, walletOne, `/api/index/jobs/${request.id}/approval`)
    await pollChain(api)
    const reviews: ReadonlyArray<NostrEvent> = [
      await event(
        jobReview,
        { job: request.id, subject: publicKeyOf(bob), rating: 5, text: 'Exact and early.' },
        alice,
        at + 10,
      ),
      await event(
        jobReview,
        { job: request.id, subject: publicKeyOf(alice), rating: 4, text: 'Clear brief.' },
        bob,
        at + 11,
      ),
    ]
    for (const review of reviews) expect((await post(api, '/api/events', review)).status).toBe(200)
    return { request, proposal, grant, reviews }
  }

  test(
    'register, claim, verify, and a settled job’s review served as checkable feedback, posted and read back',
    () =>
      settlingOn(async (api) => {
        const hire = await settledHire(api)
        const carolKey = publicKeyOf(carol)

        // Bob's wallet registers Carol with the `agentURI` the API prepares, then Bob claims the token for her.
        const call = await json(
          Erc8004RegistrationCall,
          await api.fetch(`/api/erc8004/agents/${carolKey}/registration-call`),
        )
        expect(call.agentURI).toBe(`https://sidequest.test/api/erc8004/agents/${carolKey}/registration`)
        const agentId = mintedId(await chain.send(walletTwo, { to: call.to, data: call.data }))
        const at = Math.floor(Date.now() / 1000)
        const claim = await event(
          erc8004Claim,
          {
            subject: carolKey,
            registry: identityRegistry,
            agentId: agentId.toString(),
            mcp: 'https://agents.sidequest.test/mcp',
          },
          bob,
          at,
        )
        expect((await post(api, '/api/events', claim)).status).toBe(200)
        const identityOf = async () => (await json(Person, await api.fetch(`/api/people/${carolKey}`))).erc8004
        expect(await identityOf()).toMatchObject([{ status: 'unchecked' }])
        await api.run(Effect.flatMap(Erc8004Reader, (reader) => reader.run).pipe(Effect.provide(Erc8004Reader.layer)))
        expect(await identityOf()).toMatchObject([
          { registry: identityRegistry, agentId: agentId.toString(), claimedBy: publicKeyOf(bob), status: 'verified' },
        ])

        // The registration file is the specification's, naming the token, the operator, the grant and the MCP endpoint.
        const registration = await json(
          SidequestRegistrationFile,
          await api.fetch(call.agentURI.replace('https://sidequest.test', '')),
        )
        expect(Schema.is(Erc8004RegistrationFile)(registration)).toBe(true)
        expect(registration.registrations).toEqual([{ agentId: Number(agentId), agentRegistry: identityRegistry }])
        expect(registration.sidequest).toMatchObject({ operator: publicKeyOf(bob), grant: hire.grant.id })
        expect(registration.services).toContainEqual({
          name: 'MCP',
          endpoint: 'https://agents.sidequest.test/mcp',
          version: '2026-07-28',
        })
        expect(registration.services).toContainEqual({ name: 'wallet', endpoint: accountOf(walletTwo) })

        // Carol's feedback is Alice's review of Bob, the job Carol's proposal won; Bob's and Alice's own files hold theirs.
        const fileOf = async (key: string) =>
          json(SidequestFeedbackFile, await api.fetch(`/api/erc8004/agents/${key}/feedback`))
        const file = await fileOf(carolKey)
        expect(file.items.map(({ entry }) => entry.sidequest.review.id)).toEqual([hire.reviews[0]?.id])
        const [item] = file.items
        if (item === undefined) throw new Error('No entry')
        expect(item.entry).toMatchObject({
          agentRegistry: identityRegistry,
          agentId: Number(agentId),
          value: 100,
          valueDecimals: 0,
          tag1: 'starred',
          tag2: 'sidequest',
          clientAddress: `eip155:5042002:${walletOne.address}`,
        })
        expect(item.entry.sidequest.proposal?.id).toBe(hire.proposal.id)
        expect((await fileOf(publicKeyOf(bob))).items.map(({ entry }) => entry.value)).toEqual([100])
        expect((await fileOf(publicKeyOf(alice))).items.map(({ entry }) => entry.value)).toEqual([80])

        // The document at the entry's URI is the bytes its hash is of.
        const document = await (await api.fetch(item.feedbackURI.replace('https://sidequest.test', ''))).text()
        expect(keccak256(stringToHex(document))).toBe(item.feedbackHash)

        // A third party with the file and the chain checks every entry, and catches tampering.
        const verdicts = (input: unknown) =>
          Effect.runPromise(verifyFeedbackFile(input, chain.client)).then(({ entries }) =>
            entries.map(({ failure }) => Option.getOrElse(failure, () => 'verified')),
          )
        const encoded = Schema.encodeSync(SidequestFeedbackFile)(file)
        expect(await verdicts(encoded)).toEqual(['verified'])
        expect(await verdicts(Schema.encodeSync(SidequestFeedbackFile)(await fileOf(publicKeyOf(alice))))).toEqual([
          'verified',
        ])
        const tampered = (change: (entry: SidequestFeedbackEntry) => SidequestFeedbackEntry, rehash = true) => {
          const entry = change(item.entry)
          const canonical = Result.getOrThrow(entryDocument(entry))
          const feedbackHash = rehash ? entryHash(canonical) : item.feedbackHash
          return Schema.encodeSync(SidequestFeedbackFile)({ ...file, items: [{ ...item, feedbackHash, entry }] })
        }
        const evidence = item.entry.sidequest
        expect(await verdicts(tampered((entry) => ({ ...entry, value: 20 }), false))).toEqual(['hash'])
        expect(await verdicts(tampered((entry) => ({ ...entry, value: 20 })))).toEqual(['review'])
        expect(await verdicts(tampered((entry) => ({ ...entry, createdAt: isoSeconds(0) })))).toEqual(['review'])
        expect(
          await verdicts(
            tampered((entry) => ({ ...entry, sidequest: { ...evidence, settlementTx: evidence.fundingTx } })),
          ),
        ).toEqual(['settlement'])
        expect(
          await verdicts(
            tampered((entry) => ({ ...entry, sidequest: { ...evidence, fundingTx: evidence.settlementTx } })),
          ),
        ).toEqual(['funding'])
        const swapped = { ...evidence, reviewerLink: evidence.subjectLink, subjectLink: evidence.reviewerLink }
        expect(await verdicts(tampered((entry) => ({ ...entry, sidequest: swapped })))).toEqual(['links'])
        const { proposal: _proposal, ...withoutProposal } = evidence
        expect(await verdicts(tampered((entry) => ({ ...entry, sidequest: withoutProposal })))).toEqual(['subject'])
        expect(await verdicts({ ...encoded, subject: publicKeyOf(alice) })).toEqual(['subject'])

        // Alice's wallet posts the entry on chain; Bob's, the owner's, may not.
        const feedback = await json(
          Erc8004FeedbackCall,
          await api.fetch(`/api/erc8004/agents/${carolKey}/feedback/${item.entry.sidequest.review.id}/call`),
        )
        expect(feedback.from).toBe(walletOne.address)
        await expect(chain.send(walletTwo, { to: feedback.to, data: feedback.data })).rejects.toThrow(
          /Self-feedback not allowed/u,
        )
        const posted = await chain.send(walletOne, { to: feedback.to, data: feedback.data })
        if (posted.to === null) throw new Error('No reputation registry')
        const read = await chain.client.readContract({
          address: posted.to,
          abi: erc8004ReputationAbi,
          functionName: 'readFeedback',
          args: [agentId, walletOne.address, 1n],
        })
        expect(read).toEqual([100n, 0, 'starred', 'sidequest', false])
        const logged = posted.logs.map((log) =>
          decodeEventLog({ abi: erc8004ReputationAbi, data: log.data, topics: log.topics, strict: false }),
        )
        expect(logged).toMatchObject([
          { eventName: 'NewFeedback', args: { feedbackURI: item.feedbackURI, feedbackHash: item.feedbackHash } },
        ])

        // The stage's hide list takes a hidden review out of the file, as it takes hidden things out of every list.
        const review = item.entry.sidequest.review.id
        const hide = {
          target: review,
          kind: 'event',
          reason: 'test',
          hiddenAt: at,
          hiddenBy: publicKeyOf(bob),
        } as const
        await api.run(Effect.flatMap(Moderation, (moderation) => moderation.hide(hide)))
        expect((await fileOf(carolKey)).items).toEqual([])
      }),
    120_000,
  )
})
