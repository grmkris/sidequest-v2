import { Effect } from 'effect'
import {
  fundUndelivered,
  paidOnApproval,
  reclaimedAfterExpiry,
  refundedUndelivered,
  splitByRuling,
  type Undelivered,
} from './Cases.ts'
import { arcTestnetFromEnvironment, localChainMissing, type RehearsalChain, startAnvil } from './Chain.ts'
import { evidenceFor } from './Evidence.ts'
import type { World } from './Hire.ts'
import { startProxy } from './RpcProxy.ts'
import { chainEvidence, reclaimNotRun, rehearsalRun, rehearsalStage, settlementFor } from './Stage.ts'
import { eventually, type Person, registerAgent, signIn } from './Surfaces.ts'

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

const stage = rehearsalStage(release, `local-rehearsal-${mode}`)
const { test, deployWith } = stage

/** Settlement for this chain, naming the arbitration operator once its account exists. */
const settlementOf = (chain: RehearsalChain, arbitrationOperator: string | undefined) =>
  settlementFor(chain, arbitrationOperator === undefined ? {} : { SIDEQUEST_ARBITRATION_OPERATOR: arbitrationOperator })

/** A well-formed job id no job has: a ruling for it is refused only after the arbitration operator is checked. */
const noJob = 'job_00000000000000000000000000'

/**
 * Wait until the API Worker runs with the configuration naming `arbitration` as the arbitration operator. A redeploy
 * that changes the Worker's configuration restarts it a few seconds after the deploy returns; until then the old
 * instance answers (so the status endpoint is ready at once), and at the swap the local runtime resets connections in
 * flight, which an MCP client meets as "MCP HTTP request failed". So hires start only once the new instance answers:
 * the old one refuses the arbitration operator's ruling as NotPermitted, the new one looks for the job.
 */
const untilConfigured = (arbitration: Person) =>
  eventually(
    () =>
      arbitration.post(`/api/jobs/${noJob}/ruling`, { workerShareBps: 5000 }).then(
        (reply) => reply.status !== 403,
        () => false,
      ),
    (configured) => configured,
  )

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
  const first = yield* deployWith(proxy, yield* settlementOf(chain, undefined))
  const arbitration = yield* Effect.promise(() => signIn(first, 'arbitration', chain.keys.arbitration))
  const url = yield* deployWith(proxy, yield* settlementOf(chain, arbitration.account))
  yield* Effect.promise(() => untilConfigured(arbitration))
  const buyer = yield* Effect.promise(() => signIn(url, 'buyer', chain.keys.buyer))
  const worker = yield* Effect.promise(() => signIn(url, 'worker', chain.keys.worker))
  yield* Effect.promise(async () => chain.mint?.(buyer.wallet.address, 4n * chain.amount))
  const buyerAgent = yield* Effect.promise(() => registerAgent(url, buyer, 'Buyer’s assistant', ['discuss', 'accept']))
  const workerAgent = yield* Effect.promise(() =>
    registerAgent(url, worker, 'Worker’s agent', ['discuss', 'propose', 'deliver']),
  )
  const evidence = evidenceFor(mode, release, {
    ...chainEvidence(chain),
    buyer: buyer.wallet.address,
    worker: worker.wallet.address,
  })
  const world: World = { url, chain, proxy, buyer, worker, arbitration, buyerAgent, workerAgent, evidence }
  return world
})

const { rehearse, notRun, finish } = rehearsalRun(stage, startWorld)

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
  // On Arc testnet (d) is not run, so its job is not funded: its refund would be withheld on a live chain.
  undelivered ??= await fundUndelivered(current, mode === 'anvil' ? 2 * hour : 240, mode === 'anvil')
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
    : notRun('d', 'settlement withheld until expiry, reclaimed by the buyer', reclaimNotRun),
  { timeout: 300_000 },
)

test('leaves no relayer transaction unsettled, and writes the evidence', finish, { timeout: 60_000 })
