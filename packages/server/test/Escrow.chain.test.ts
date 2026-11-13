import { EscrowFunding, Relayed } from '@sidequest/protocol'
import { ChainRpc } from '@sidequest/settlement/ChainRpc'
import { Effect, Layer, Option, Schema } from 'effect'
import { isHex } from 'viem'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { signTyped } from '../rehearsal/Surfaces.ts'
import { ChainFacts } from '../src/Index/ChainFacts.ts'
import { ChainLogPoller } from '../src/Index/ChainLogPoller.ts'
import { type LocalChain, onChainOnly, skipOnChain, startChain } from './Anvil.ts'
import { type Api, withApi } from './HttpWorld.ts'
import { accountOf, alice, bob, linked, walletOne, walletTwo } from './IndexWorld.ts'
import { proposalBy, requestBy, termsFrom } from './JobWorld.ts'
import { serverWorld } from './World.ts'

// The escrow against a real chain: Anvil running the Foundry build of the audited escrow and `SidequestOperator` (see
// Anvil.ts). The buyer's key posts a request and links a wallet, the worker's key proposes, the buyer's wallet signs
// the funding the API quotes, the relayer funds it; then the index's chain log poller reads the funding from the
// chain's logs. Skipped with a notice where Anvil or the contracts build is missing, and failed in CI, which has both.

const amount = 250_000_000n

const post = (api: Api, path: string, body: unknown) =>
  api.fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

const json = async <A>(schema: Schema.Decoder<A>, response: Response) => {
  const body: unknown = await response.json()
  if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(body)}`)
  return Schema.decodeUnknownSync(schema)(body)
}

describe.skipIf(skipOnChain)('the escrow on chain', () => {
  onChainOnly('the escrow on chain')
  let chain: LocalChain
  beforeAll(async () => {
    chain = await startChain()
  }, 60_000)
  afterAll(() => chain?.stop())

  const onChain = (run: Parameters<typeof withApi>[0]) =>
    withApi(run, serverWorld(chain.client, { escrow: Option.some(chain.config) }).layer)

  /** The buyer's wallet funds the worker's proposal through the API; answers the request and the funding's block. */
  const funded = async (api: Api) => {
    const at = Math.floor(Date.now() / 1000)
    const request = await requestBy(alice, at)
    const proposal = await proposalBy(bob, request, at + 1, termsFrom(at, String(amount)), accountOf(walletTwo))
    for (const event of [await linked(alice, walletOne, at), request, proposal])
      expect((await post(api, '/api/events', event)).status).toBe(200)
    await chain.mint(walletOne.address, amount)
    const path = `/api/index/jobs/${request.id}/proposals/${proposal.id}/funding`
    const quote = await json(EscrowFunding, await api.fetch(`${path}?payer=${walletOne.address}`))
    expect(quote).toMatchObject({ amount: String(amount), escrow: chain.chain.escrow })
    const signature = await signTyped(walletOne, quote.typedData)
    const { transactionHash } = await json(Relayed, await post(api, path, { payer: walletOne.address, signature }))
    if (!isHex(transactionHash)) throw new Error('No transaction hash')
    const receipt = await chain.client.waitForTransactionReceipt({ hash: transactionHash })
    expect(receipt.status).toBe('success')
    return { request, block: receipt.blockNumber }
  }

  test(
    'the chain log poller records a funding once, and only once its block is confirmed',
    () =>
      onChain(async (api) => {
        const { request, block } = await funded(api)
        const head = await chain.client.getBlockNumber({ cacheTime: 0 })
        /** One pass of the poller, reading from block 0, counting `confirmations` blocks as confirming a log. */
        const pass = (confirmations: number) =>
          api.run(
            Effect.gen(function* () {
              yield* (yield* ChainLogPoller).run
              const facts = yield* ChainFacts
              return {
                facts: yield* facts.forJob(request.id),
                scannedTo: Option.getOrNull(yield* facts.scannedTo(chain.chain.asset.network)),
              }
            }).pipe(
              Effect.provide(
                ChainLogPoller.layer({ ...chain.chain, confirmations }, Option.some(0n)).pipe(
                  Layer.provide(Layer.succeed(ChainRpc, chain.client)),
                ),
              ),
            ),
          )
        // The funding's block is one short of confirmed: nothing recorded, and the cursor stops before it.
        expect(await pass(Number(head - block) + 2)).toEqual({ facts: [], scannedTo: Number(block) - 1 })
        const confirmed = await pass(Number(head - block) + 1)
        expect(confirmed.scannedTo).toBe(Number(block))
        expect(confirmed.facts).toMatchObject([
          { _tag: 'Funded', job: request.id, amount: String(amount), at: { block: Number(block) } },
        ])
        // Every later pass re-reads blocks below its cursor; the funding is still one fact.
        expect((await pass(1)).facts).toEqual(confirmed.facts)
        expect((await pass(1)).facts).toHaveLength(1)
      }),
    60_000,
  )
})
