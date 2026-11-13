import { system } from '@sidequest/domain/Actor'
import { CurrentActor } from '@sidequest/domain/CurrentActor.context'
import { Account } from '@sidequest/domain/Identity/Account.aggregate'
import { ClaimWallet } from '@sidequest/domain/Identity/ClaimWallet.command'
import { RegisterAccount } from '@sidequest/domain/Identity/RegisterAccount.command'
import { ReserveWallet } from '@sidequest/domain/Identity/ReserveWallet.command'
import { WalletClaim } from '@sidequest/domain/Identity/WalletClaim.aggregate'
import { AccountId, EscrowStatus, FundingRequest, type JobId, Relayed, TypedData } from '@sidequest/protocol'
import { ChainRpc } from '@sidequest/settlement/ChainRpc'
import { jobIdWord } from '@sidequest/settlement/Words'
import { Effect, Layer, Option } from 'effect'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { ChainFacts } from '../src/Index/ChainFacts.ts'
import { ChainLogPoller } from '../src/Index/ChainLogPoller.ts'
import { walletRef } from '../src/SignIn/Siwe.ts'
import { type LocalChain, onChainOnly, skipOnChain, startChain } from './Anvil.ts'
import { artifactHash, buyerViewOf, named, postJob, propose } from './Hire.ts'
import { ada, ben, bodyOf, cy, type Person, terms, withApi } from './HttpWorld.ts'
import { callTool, grantedAgent } from './McpWorld.ts'
import { signInWorld } from './World.ts'
import { signTyped } from '../rehearsal/Surfaces.ts'

// The whole hire against a real chain: Anvil running the Foundry build of the audited escrow and `SidequestOperator`
// (see Anvil.ts). Each person signs with their own key; the server relays and records only what its chain reader
// verified. Skipped with a notice where Anvil or the contracts build is missing, and failed in CI, which has both.

const fast = { pollMillis: 25, maxPollMillis: 200, idleMillis: 200 }
const operator = AccountId.make('account_01JCXZ4Q6N8M2V7T3R5W9Y0B1Z')
const amount = 250_000_000n
const url = 'https://files.example/logo.zip'

/** Claims Cy's wallet for the arbitration operator's account before Cy first signs in, as sign-in would. */
const claimOperatorWallet = Effect.gen(function* () {
  const wallet = walletRef(cy.address)
  const claims = yield* WalletClaim
  yield* claims
    .send(wallet, new ReserveWallet({ account: operator }))
    .pipe(Effect.provideService(CurrentActor, system('sign-in')))
  yield* (yield* Account)
    .send(operator, new RegisterAccount({ displayName: 'Arbitration', wallet }))
    .pipe(Effect.provideService(CurrentActor, { account: operator }))
  yield* claims
    .send(wallet, new ClaimWallet({ account: operator }))
    .pipe(Effect.provideService(CurrentActor, system('sign-in')))
}).pipe(Effect.orDie)

/** Ben hands over the artifact and signs its hash onto the chain. */
const deliver = async (buyer: Person, worker: Person, job: JobId) => {
  expect((await worker.post(`/api/jobs/${job}/delivery`, { artifactHash, url })).status).toBe(204)
  const toSign = bodyOf(TypedData, await worker.get(`/api/jobs/${job}/delivery/signature`))
  const posted = await worker.post(`/api/jobs/${job}/delivery/signature`, { signature: await signTyped(ben, toSign) })
  expect(posted.status).toBe(200)
  return buyerViewOf(buyer, job, (view) => view.state === 'Delivered')
}

describe.skipIf(skipOnChain)('the hire on chain', () => {
  onChainOnly('the hire on chain')
  let chain: LocalChain
  beforeAll(async () => {
    chain = await startChain()
  }, 60_000)
  afterAll(() => chain?.stop())

  const onChain = (journey: Parameters<typeof withApi>[0]) =>
    withApi(
      journey,
      signInWorld(chain.client, { escrow: Option.some(chain.config(Option.some(operator))), timing: fast }).layer,
    )

  /** Ada hires Ben for a logo and funds the escrow from her wallet; the job is funded once the chain shows it. */
  const fundedHire = async (signIn: (signer: typeof ada) => Promise<Person>) => {
    const buyer = await signIn(ada)
    const worker = await signIn(ben)
    const job = await postJob(buyer)
    await propose(worker, job, undefined, terms(String(amount)))
    const [offer] = (await buyerViewOf(buyer, job, (view) => view.proposals.length === 1)).proposals
    if (offer === undefined) throw new Error('No proposal arrived')
    await buyer.post(`/api/jobs/${job}/acceptance`, named(offer))
    await buyerViewOf(buyer, job, (view) => view.state === 'Awarded')
    await chain.mint(ada.address, amount)
    const funding = bodyOf(FundingRequest, await buyer.get(`/api/jobs/${job}/funding`))
    expect(funding).toMatchObject({
      payer: ada.address,
      receiver: ben.address,
      amount: String(amount),
      operator: chain.chain.operator,
      arbitrator: chain.chain.arbitrator,
      feeBps: 500,
      feeReceiver: chain.chain.feeReceiver,
    })
    // Nothing a client sends funds a job: a signature that does not authorize the payment is refused by the chain.
    expect(
      await buyer.post(`/api/jobs/${job}/funding`, { signature: await signTyped(cy, funding.typedData) }),
    ).toMatchObject({
      status: 409,
      body: { reason: 'ChainRefused' },
    })
    const relayed = await buyer.post(`/api/jobs/${job}/funding`, { signature: await signTyped(ada, funding.typedData) })
    expect(relayed.status).toBe(200)
    bodyOf(Relayed, relayed)
    await buyerViewOf(buyer, job, (view) => view.state === 'Funded')
    return { buyer, worker, job }
  }

  test(
    'funds, delivers and approves: the worker is paid, the treasury takes its fee',
    () =>
      onChain(async (api) => {
        const paidBefore = await chain.balanceOf(ben.address)
        const feesBefore = await chain.balanceOf(chain.treasury)
        const { buyer, worker, job } = await fundedHire(api.signIn)
        // The worker's agent reads the same chain reader's status over MCP.
        const { token } = await grantedAgent(worker, ['deliver'])
        expect((await callTool(api, token, 'payment_status', { job })).structuredContent).toMatchObject({
          payment: { stage: 'Funded', funding: { amount: String(amount) } },
          nextAction: null,
        })
        const delivered = await deliver(buyer, worker, job)
        expect(delivered.review?.reviewEndsAt).toBe((delivered.review?.deliveredAt ?? 0) + 3 * 86_400)
        const approval = bodyOf(TypedData, await buyer.get(`/api/jobs/${job}/approval`))
        expect(
          await worker.post(`/api/jobs/${job}/approval`, { signature: await signTyped(ben, approval) }),
        ).toMatchObject({
          status: 403,
        })
        expect(
          (await buyer.post(`/api/jobs/${job}/approval`, { signature: await signTyped(ada, approval) })).status,
        ).toBe(200)
        const settled = await buyerViewOf(buyer, job, (view) => view.state === 'Settled')
        expect(settled).toMatchObject({
          outcome: 'paid',
          settlement: [{ operation: 'capture', amount: String(amount) }],
        })
        expect((await chain.balanceOf(ben.address)) - paidBefore).toBe(237_500_000n)
        expect((await chain.balanceOf(chain.treasury)) - feesBefore).toBe(12_500_000n)
        const status = bodyOf(EscrowStatus, await worker.get(`/api/jobs/${job}/payment`))
        expect(status).toMatchObject({ stage: 'Settled', settlement: { outcome: 'Approved' }, problems: [] })
      }),
    60_000,
  )

  test(
    'the index’s chain log poller records the funding once, and only once its block is confirmed',
    () =>
      onChain(async ({ signIn, run }) => {
        const { job } = await fundedHire(signIn)
        const word = jobIdWord(job)
        const head = await chain.client.getBlockNumber()
        const logs = await chain.client.getLogs({ address: chain.chain.operator, fromBlock: 0n, toBlock: head })
        const funding = logs.find((log) => log.topics[2] === word)?.blockNumber
        if (funding == null) throw new Error('No JobFunded for the job')
        /** One pass of the poller, reading from block 0, counting `confirmations` blocks as confirming a log. */
        const pass = (confirmations: number) =>
          run(
            Effect.gen(function* () {
              yield* (yield* ChainLogPoller).run
              const facts = yield* ChainFacts
              return {
                facts: yield* facts.forJob(word.slice(2)),
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
        expect(await pass(Number(head - funding) + 2)).toEqual({ facts: [], scannedTo: Number(funding) - 1 })
        const confirmed = await pass(Number(head - funding) + 1)
        expect(confirmed.scannedTo).toBe(Number(funding))
        expect(confirmed.facts).toMatchObject([
          { _tag: 'Funded', job: word.slice(2), amount: String(amount), at: { block: Number(funding) } },
        ])
        // Every later pass re-reads blocks below its cursor; the funding is still one fact.
        expect((await pass(1)).facts).toEqual(confirmed.facts)
        expect((await pass(1)).facts).toHaveLength(1)
      }),
    60_000,
  )

  test(
    'a rejection opens a dispute, and the interim arbitrator splits it',
    () =>
      onChain(async ({ signIn, run }) => {
        await run(claimOperatorWallet)
        const refundBefore = await chain.balanceOf(ada.address)
        const paidBefore = await chain.balanceOf(ben.address)
        const { buyer, worker, job } = await fundedHire(signIn)
        await deliver(buyer, worker, job)
        const rejection = bodyOf(TypedData, await buyer.get(`/api/jobs/${job}/rejection`))
        const reason = 'The favicon set is missing.'
        const rejected = await buyer.post(`/api/jobs/${job}/rejection`, {
          signature: await signTyped(ada, rejection),
          reason,
        })
        expect(rejected.status).toBe(200)
        const disputed = await buyerViewOf(
          buyer,
          job,
          (view) => view.state === 'Disputed' && view.dispute?.reason != null,
        )
        expect(disputed.dispute).toMatchObject({ reason, ruling: null })
        expect(await buyer.post(`/api/jobs/${job}/ruling`, { workerShareBps: 0 })).toMatchObject({ status: 403 })
        const arbitration = await signIn(cy)
        expect(arbitration.account).toBe(operator)
        expect((await arbitration.post(`/api/jobs/${job}/ruling`, { workerShareBps: 6000 })).status).toBe(200)
        const settled = await buyerViewOf(buyer, job, (view) => view.state === 'Settled')
        expect(settled).toMatchObject({ outcome: 'split', dispute: { reason, workerShareBps: 6000, ruling: 'split' } })
        expect((await chain.balanceOf(ben.address)) - paidBefore).toBe(142_500_000n)
        // Ada was minted the amount, paid it into the escrow, and the ruling voided 40 % of it back to her.
        expect((await chain.balanceOf(ada.address)) - refundBefore).toBe(100_000_000n)
      }),
    60_000,
  )

  test(
    'after a silent review window the saga settles it for the worker',
    () =>
      onChain(async ({ signIn }) => {
        const paidBefore = await chain.balanceOf(ben.address)
        const { buyer, worker, job } = await fundedHire(signIn)
        await deliver(buyer, worker, job)
        await chain.advance(3 * 86_400 + 1)
        const settled = await buyerViewOf(buyer, job, (view) => view.state === 'Settled')
        expect(settled.outcome).toBe('paid')
        expect((await chain.balanceOf(ben.address)) - paidBefore).toBe(237_500_000n)
        const status = bodyOf(EscrowStatus, await buyer.get(`/api/jobs/${job}/payment`))
        expect(status.settlement?.outcome).toBe('AcceptedBySilence')
      }),
    60_000,
  )
})
