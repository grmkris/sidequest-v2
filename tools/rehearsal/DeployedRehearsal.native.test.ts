import { afterAll, beforeAll, expect, test } from 'bun:test'
import { type DeployedWorld, startDeployedWorld } from '../../packages/server/rehearsal/DeployedWorld.ts'
import { type CaseResult, recordCase, summaryOf, writeEvidence } from '../../packages/server/rehearsal/Evidence.ts'
import {
  fundUndeliveredDeals,
  refundedBySettler,
  releasedAfterDelegatedDelivery,
  releasedOnApproval,
  ruledAfterRejection,
} from '../../packages/server/rehearsal/GateCases.ts'
import { reclaimNotRun } from '../../packages/server/rehearsal/Stage.ts'
import { callSummary, withCalls } from '../../packages/server/rehearsal/StageCalls.ts'

// The phase 2 technical gate against a stage deployed on Cloudflare (`REHEARSAL_TARGET`, its gateway at
// `REHEARSAL_GATEWAY`), on Arc testnet: the same hires as the local rehearsal, through the stage's public surfaces
// only, deploying nothing (packages/server/rehearsal/DeployedWorld.ts). The stage's own relayer pays the gas, its
// chain log poller and settler run on its Cron Triggers on Cloudflare, and the rehearsal reads the chain only to check
// balances and wait for confirmations. `bun run gate:rehearse` runs it when REHEARSAL_TARGET is set.

/**
 * How long (c) waits, after the deadline passed on chain, for the fold to say refunded: 480 s. The refund needs, in
 * turn: a settler run (the minute Cron Trigger, which Cloudflare may start some seconds late) whose newest confirmed
 * block, three deep, is past the deadline, so up to two runs (~150 s); the relayed call's inclusion and three
 * confirmations (6 to 60 s measured on Arc testnet on 2026-11-13); the poller's next run to record it (~75 s); and
 * the next read (2 s). 480 s covers that sum (~290 s) with a missed run of each to spare. Measured locally against
 * Arc testnet the same wait took 115 s.
 */
const refundBudget = 480

/** (c)'s delivery deadline: four minutes after agreeing, as on Arc testnet locally. */
const refundDeadline = 240

let world: DeployedWorld | undefined
const current = () => {
  if (world === undefined) throw new Error('The deployed stage did not start')
  return world
}

beforeAll(async () => {
  world = await startDeployedWorld({ ...process.env })
}, 300_000)

afterAll(() => world?.calls.stop())

const rehearse = (name: string, title: string, run: (on: DeployedWorld) => Promise<CaseResult>) => async () => {
  const on = current()
  const outcome = await recordCase(on.evidence, name, title, () => run(on))
  expect(outcome).toMatchObject({ status: 'passed' })
}

const notRun = (name: string, title: string, reason: string) => () => {
  current().evidence.cases.push({ case: name, title, status: 'not run', reason })
}

test(
  '(a) the worker’s agent proposes over MCP; the buyer accepts and funds; the worker’s wallet delivers; approved',
  rehearse('a', 'agent proposes, released on approval with the exact fee', releasedOnApproval),
  { timeout: 900_000 },
)

const rulingTitle = 'rejected, then ruled through NIP-98'
test(
  '(b) the buyer rejects; a ruling asked for by the stage’s arbitration key over NIP-98 splits it: ruled',
  process.env['REHEARSAL_ARBITRATION_NOSTR_KEY'] === undefined
    ? notRun('b', rulingTitle, 'REHEARSAL_ARBITRATION_NOSTR_KEY (the stage’s arbitration Nostr key) was not given')
    : rehearse('b', rulingTitle, ruledAfterRejection),
  { timeout: 900_000 },
)

test(
  '(e) the worker’s wallet delegates once; the agent delivers over MCP with no wallet signature; approved',
  rehearse('e', 'delivered by the agent’s key under one delegation, approved', releasedAfterDelegatedDelivery),
  { timeout: 900_000 },
)

test(
  '(c) funded and never delivered: after the deadline the deployed settler refunds the buyer',
  rehearse('c', 'never delivered, refunded by the settler on Cloudflare', async (on) =>
    refundedBySettler(on, await fundUndeliveredDeals(on, refundDeadline, false), refundBudget),
  ),
  { timeout: 1_500_000 },
)

test(
  '(d) settlement withheld until the escrow expires: not run against a deployed stage',
  notRun(
    'd',
    'settlement withheld until expiry, reclaimed by the buyer',
    `${reclaimNotRun}; and a deployed stage's calls cannot be withheld`,
  ),
)

test('writes the evidence, with every request to the stage under the step it led to', () => {
  const on = current()
  on.evidence.steps.splice(0, on.evidence.steps.length, ...withCalls(on.evidence.steps, on.calls.calls))
  on.evidence.stage = callSummary(on.calls.calls, on.evidence)
  const path = writeEvidence(on.evidence)
  process.stdout.write(`\n${summaryOf(on.evidence)}\n  evidence: ${path.pathname}\n\n`)
  expect(on.evidence.cases.filter(({ status }) => status === 'failed')).toEqual([])
})
