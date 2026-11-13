import { expect } from 'bun:test'
import * as Cloudflare from '@alchemy.run/cloudflare'
import * as Alchemy from 'alchemy'
import * as Test from 'alchemy/Test/Bun'
import { Effect, Redacted } from 'effect'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import { privateKeyToAccount } from 'viem/accounts'
import { type SettlementVariables, settlementVariablesOf } from '../src/Settlement/SettlementStage.ts'
import { compatibility, sidequestWorkers } from '../src/Stack.ts'
import type { RehearsalChain } from './Chain.ts'
import { type CaseResult, type Evidence, summaryOf, writeEvidence } from './Evidence.ts'
import { relayerSettled } from './RelayerCheck.ts'
import type { RpcProxy } from './RpcProxy.ts'

// What every gate rehearsal deploys: the whole built stack in workerd, as the native acceptance test runs it, with
// settlement configured as a stage would configure it, against a chain reached only through the rehearsal's proxy.

/**
 * Settlement as a stage binds it, for this chain: the keys as secrets, a fast saga pace for a chain whose clock moves,
 * and `extra` plain variables (the arbitration operator, the arbitration key, the operator's deployment block).
 */
export const settlementFor = (chain: RehearsalChain, extra: Readonly<Record<string, string>>) => {
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
    ...extra,
  }
  const secrets = {
    SIDEQUEST_RELAYER_KEY: Redacted.make(chain.keys.relayer),
    SIDEQUEST_ARBITRATOR_KEY: Redacted.make(chain.keys.arbitrator),
  }
  return settlementVariablesOf(plain, secrets)
}

/**
 * The rehearsal's stack on the local stage `stage`, with the test functions bound to it. `deployWith` deploys (or
 * redeploys) it with `settlement`, reaching the chain through `proxy`, and waits until the edge serves the API.
 */
export const rehearsalStage = (release: string, stage: string) => {
  /** What the stack is deployed with; filled in before each deploy, read when the stack's program runs. */
  const settings: { rpcUrl: string; settlement: SettlementVariables } = {
    rpcUrl: 'http://127.0.0.1:9',
    settlement: {},
  }
  const Stack = Alchemy.Stack(
    'SidequestGateRehearsal',
    { providers: Cloudflare.providers(), state: Alchemy.localState() },
    Effect.suspend(() =>
      sidequestWorkers(
        release,
        (api) =>
          Cloudflare.Worker('SidequestWebsite', {
            main: 'apps/web/dist/server/fetch.js',
            assets: { directory: 'apps/web/dist/client' },
            compatibility,
            env: { API: api },
          }),
        settings.rpcUrl,
        settings.settlement,
      ),
    ),
  )
  const harness = Test.make({
    providers: Cloudflare.providers(),
    state: Alchemy.localState(),
    stage,
    dev: true,
    sidecar: { omitEnv: ['CLOUDFLARE_'] },
  })
  const deployWith = (proxy: RpcProxy, settlement: SettlementVariables) =>
    Effect.gen(function* () {
      settings.rpcUrl = proxy.url
      settings.settlement = settlement
      const { url } = yield* harness.deploy(Stack)
      yield* Test.getWhenReady(`${url}/api/status`)
      return url
    }).pipe(Effect.provide(FetchHttpClient.layer))
  return { ...harness, Stack, deployWith }
}

/** The chain's contracts, the amount and the two service keys' addresses, for the evidence. */
export const chainEvidence = (chain: RehearsalChain) => ({
  chainId: 5042002,
  escrow: chain.escrow,
  collector: chain.collector,
  token: chain.token,
  operator: chain.operator,
  treasury: chain.treasury,
  amount: String(chain.amount),
  relayer: privateKeyToAccount(chain.keys.relayer).address,
  arbitrator: privateKeyToAccount(chain.keys.arbitrator).address,
})

/** What every rehearsal's world holds: the chain, its proxy and the evidence being written. */
interface Rehearsed {
  readonly chain: RehearsalChain
  readonly proxy: RpcProxy
  readonly evidence: Evidence
}

/**
 * A rehearsal's run on `stage`: the world `start` makes before every case and tears down after them all, `rehearse`
 * to run one case and record it, passed or failed, in the evidence, and `finish`, which checks that the relayer left
 * nothing unsettled and writes the evidence.
 */
export const rehearsalRun = <W extends Rehearsed>(
  stage: ReturnType<typeof rehearsalStage>,
  start: Test.TestEffect<W>,
) => {
  const world = stage.beforeAll(start, { timeout: 240_000 })
  stage.afterAll(
    Effect.gen(function* () {
      const { chain, proxy } = yield* world
      proxy.stop()
      chain.stop()
      yield* stage.destroy(stage.Stack)
    }),
    { timeout: 60_000 },
  )
  const rehearse = (name: string, title: string, run: (current: W) => Promise<CaseResult>) =>
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
  const finish = Effect.gen(function* () {
    const current = yield* world
    current.evidence.relayer = yield* Effect.promise(() => relayerSettled(current))
    const path = writeEvidence(current.evidence)
    process.stdout.write(`\n${summaryOf(current.evidence)}\n  evidence: ${path.pathname}\n\n`)
    expect(current.evidence.cases.filter(({ status }) => status === 'failed')).toEqual([])
  })
  return { world, rehearse, finish }
}
