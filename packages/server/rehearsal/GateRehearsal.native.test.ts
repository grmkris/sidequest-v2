import { expect } from 'bun:test'
import * as Cloudflare from '@alchemy.run/cloudflare'
import * as Alchemy from 'alchemy'
import * as Test from 'alchemy/Test/Bun'
import { Effect, Redacted } from 'effect'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import { privateKeyToAccount } from 'viem/accounts'
import { type SettlementVariables, settlementVariablesOf } from '../src/Settlement/SettlementStage.ts'
import { compatibility, sidequestWorkers } from '../src/Stack.ts'
import {
  fundUndelivered,
  paidOnApproval,
  reclaimedAfterExpiry,
  refundedUndelivered,
  splitByRuling,
  type Undelivered,
} from './Cases.ts'
import { arcTestnetFromEnvironment, localChainMissing, type RehearsalChain, startAnvil } from './Chain.ts'
import { type CaseResult, evidenceFor, summaryOf, writeEvidence } from './Evidence.ts'
import type { World } from './Hire.ts'
import { relayerSettled } from './RelayerCheck.ts'
import { type RpcProxy, startProxy } from './RpcProxy.ts'
import { registerAgent, signIn } from './Surfaces.ts'

// The phase 1 technical gate, rehearsed (docs/ROADMAP.md): two unrelated accounts complete escrowed hires through MCP
// clients, including a rejection settled by a ruling and a buyer's reclaim. The whole built stack runs in workerd as
// the native acceptance test runs it, with settlement configured as a stage would configure it, against a chain
// reached only through a JSON-RPC proxy. `bun run gate:rehearse` runs it (tools/gate-rehearsal.ts).
//
// REHEARSAL_CHAIN picks the chain: `anvil` (default) deploys everything on a fresh Anvil and moves its clock through
// every window; `arc-testnet` uses deployed contracts and funded keys from the environment (see Chain.ts) and runs
// only what fits in real time: (a), (b) and (c); (d) needs the escrow to expire, 38 hours or more after funding.

const release = process.env['VITE_SIDEQUEST_RELEASE'] ?? 'rehearsal'
const mode = process.env['REHEARSAL_CHAIN'] === 'arc-testnet' ? 'arc-testnet' : 'anvil'
const hour = 3600

/** What the stack is deployed with; filled in before each deploy, read when the stack's program runs. */
const settings: { rpcUrl: string; settlement: SettlementVariables } = { rpcUrl: 'http://127.0.0.1:9', settlement: {} }

const Stack = Alchemy.Stack(
  'SidequestGateRehearsal',
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  Effect.suspend(() =>
    sidequestWorkers(
      release,
      Cloudflare.Worker('SidequestWebsite', {
        main: 'apps/web/dist/server/fetch.js',
        assets: { directory: 'apps/web/dist/client' },
        compatibility,
      }),
      settings.rpcUrl,
      settings.settlement,
    ),
  ),
)

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Alchemy.localState(),
  stage: `local-rehearsal-${mode}`,
  dev: true,
  sidecar: { omitEnv: ['CLOUDFLARE_'] },
})

/** Settlement as a stage binds it, for this chain: the keys as secrets, a fast saga pace for a chain whose clock moves. */
const settlementFor = (chain: RehearsalChain, arbitrationOperator: string | undefined) => {
  const local =
    chain.mode === 'anvil'
      ? {
          SIDEQUEST_ESCROW_ADDRESS: chain.escrow,
          SIDEQUEST_COLLECTOR_ADDRESS: chain.collector,
          SIDEQUEST_TOKEN_DOMAIN_NAME: chain.tokenDomain.name,
          SIDEQUEST_TOKEN_DOMAIN_VERSION: chain.tokenDomain.version,
        }
      : {}
  const plain = {
    SIDEQUEST_OPERATOR_ADDRESS: chain.operator,
    SIDEQUEST_TREASURY_ADDRESS: chain.treasury,
    SIDEQUEST_ARBITRATOR_ADDRESS: privateKeyToAccount(chain.keys.arbitrator).address,
    SIDEQUEST_CONFIRMATIONS: String(chain.confirmations),
    SIDEQUEST_SETTLEMENT_TIMING: chain.mode === 'anvil' ? '250,1000,1000' : '2000,15000,15000',
    ...local,
    ...(arbitrationOperator === undefined ? {} : { SIDEQUEST_ARBITRATION_OPERATOR: arbitrationOperator }),
  }
  const secrets = {
    SIDEQUEST_RELAYER_KEY: Redacted.make(chain.keys.relayer),
    SIDEQUEST_ARBITRATOR_KEY: Redacted.make(chain.keys.arbitrator),
  }
  return settlementVariablesOf(plain, secrets)
}

/** Deploy (or redeploy) the stack with `settlement`, and wait until the edge serves the API. */
const deployWith = (proxy: RpcProxy, settlement: SettlementVariables) =>
  Effect.gen(function* () {
    settings.rpcUrl = proxy.url
    settings.settlement = settlement
    const { url } = yield* deploy(Stack)
    yield* Test.getWhenReady(`${url}/api/status`)
    return url
  }).pipe(Effect.provide(FetchHttpClient.layer))

/**
 * The chain, the proxy and the stack, and the people and agents of the hire. The arbitration operator is an account,
 * which exists only once its person signed in: so the stack is deployed, that person signs in, and the stack is
 * deployed again naming the account, as an operator configuring a stage would.
 */
const startWorld = Effect.gen(function* () {
  const missing = mode === 'anvil' ? localChainMissing() : undefined
  if (missing !== undefined)
    return yield* Effect.die(new Error(`The rehearsal needs Anvil and the contracts: ${missing}`))
  const chain = yield* Effect.promise(() =>
    mode === 'anvil' ? startAnvil(250_000_000n) : arcTestnetFromEnvironment(process.env),
  )
  const proxy = startProxy(chain.rpcUrl, { chainId: 5042002, escrow: chain.escrow, operator: chain.operator })
  const first = yield* deployWith(proxy, yield* settlementFor(chain, undefined))
  const arbitration = yield* Effect.promise(() => signIn(first, 'arbitration', chain.keys.arbitration))
  const url = yield* deployWith(proxy, yield* settlementFor(chain, arbitration.account))
  const buyer = yield* Effect.promise(() => signIn(url, 'buyer', chain.keys.buyer))
  const worker = yield* Effect.promise(() => signIn(url, 'worker', chain.keys.worker))
  yield* Effect.promise(async () => chain.mint?.(buyer.wallet.address, 4n * chain.amount))
  const buyerAgent = yield* Effect.promise(() => registerAgent(url, buyer, 'Buyer’s assistant', ['discuss', 'accept']))
  const workerAgent = yield* Effect.promise(() =>
    registerAgent(url, worker, 'Worker’s agent', ['discuss', 'propose', 'deliver']),
  )
  const evidence = evidenceFor(mode, release, {
    chainId: 5042002,
    escrow: chain.escrow,
    collector: chain.collector,
    token: chain.token,
    operator: chain.operator,
    treasury: chain.treasury,
    amount: String(chain.amount),
    buyer: buyer.wallet.address,
    worker: worker.wallet.address,
    relayer: privateKeyToAccount(chain.keys.relayer).address,
    arbitrator: privateKeyToAccount(chain.keys.arbitrator).address,
  })
  const world: World = { url, chain, proxy, buyer, worker, arbitration, buyerAgent, workerAgent, evidence }
  return world
})

const world = beforeAll(startWorld, { timeout: 240_000 })
afterAll(
  Effect.gen(function* () {
    const { chain, proxy } = yield* world
    proxy.stop()
    chain.stop()
    yield* destroy(Stack)
  }),
  { timeout: 60_000 },
)

/** Run a case and record it, passed or failed, in the evidence. */
const rehearse = (name: string, title: string, run: (world: World) => Promise<CaseResult>) =>
  Effect.gen(function* () {
    const current = yield* world
    const outcome = yield* Effect.promise(() =>
      run(current).then(
        (result) => result,
        (cause: unknown): CaseResult => ({ case: name, title, status: 'failed', reason: String(cause) }),
      ),
    )
    current.evidence.cases.push(outcome)
    expect(outcome).toMatchObject({ status: 'passed' })
  })

test(
  '(a) an agent proposes, the buyer funds, the work is delivered and approved: paid with the exact fee',
  rehearse('a', 'approved and paid with the exact fee', paidOnApproval),
  {
    timeout: 180_000,
  },
)

test(
  '(b) the buyer rejects; the arbitration operator splits it: both receive their share',
  rehearse('b', 'rejected, then split by a ruling', splitByRuling),
  {
    timeout: 180_000,
  },
)

let undelivered: Undelivered | undefined
const funded = async (current: World) => {
  undelivered ??= await fundUndelivered(current, mode === 'anvil' ? 2 * hour : 240)
  return undelivered
}

test(
  '(c) funded and never delivered: after the deadline the saga refunds the buyer',
  rehearse('c', 'funded, never delivered, refunded by the saga', async (current) =>
    refundedUndelivered(current, await funded(current)),
  ),
  {
    timeout: 600_000,
  },
)

test(
  '(d) settlement withheld until the escrow expires: the buyer reclaims, the job ends refunded',
  mode === 'anvil'
    ? rehearse('d', 'settlement withheld until expiry, reclaimed by the buyer', async (current) =>
        reclaimedAfterExpiry(current, await funded(current)),
      )
    : Effect.gen(function* () {
        const current = yield* world
        current.evidence.cases.push({
          case: 'd',
          title: 'settlement withheld until expiry, reclaimed by the buyer',
          status: 'not run',
          reason:
            'the escrow expires at least 38 h after funding (review 1 h + dispute 1 h + arbitration 12 h + 24 h margin)',
        })
      }),
  { timeout: 300_000 },
)

test(
  'leaves no relayer transaction unsettled, and writes the evidence',
  Effect.gen(function* () {
    const current = yield* world
    current.evidence.relayer = yield* Effect.promise(() => relayerSettled(current))
    const path = writeEvidence(current.evidence)
    process.stdout.write(`\n${summaryOf(current.evidence)}\n  evidence: ${path.pathname}\n\n`)
    expect(current.evidence.cases.filter(({ status }) => status === 'failed')).toEqual([])
  }),
  { timeout: 60_000 },
)
