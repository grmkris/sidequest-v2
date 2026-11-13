import { gatewayWorker } from '@sidequest/gateway/Stack'
import { Effect, Redacted } from 'effect'
import { arcTestnetFromEnvironment, localChainMissing, startAnvil } from '../../packages/server/rehearsal/Chain.ts'
import {
  type EventsWorld,
  fundUndeliveredDeals,
  reclaimedByBuyer,
  refundedBySettler,
  releasedAfterDelegatedDelivery,
  releasedOnApproval,
  ruledAfterRejection,
  type UndeliveredDeals,
} from '../../packages/server/rehearsal/EventsCases.ts'
import { startEventsWorld } from '../../packages/server/rehearsal/EventsWorld.ts'
import { reclaimNotRun, rehearsalRun, rehearsalStage } from '../../packages/server/rehearsal/Stage.ts'

// The phase 2 technical gate rehearsed (docs/ROADMAP.md): two Nostr keys complete escrowed hires through signed
// events and the agent gateway, including a rejection settled by a ruling, with no session and no server-held chat.
// The core and the gateway run together in workerd, each its own Worker and D1, the gateway knowing only the core's
// URL. The buyer is a person's key over HTTP; the worker acts through an MCP client over OAuth to their agent at the
// gateway, whose key signs under the worker's grant, and the worker's wallet signs only money. Money's stage is read
// from the index's fold, fed by the chain log poller and settled by the settler on the API Worker's minute Cron
// Trigger, which fires in the local runtime as on a stage. `bun run gate:rehearse:events` runs it
// (tools/gate-rehearsal.ts).
//
// REHEARSAL_CHAIN picks the chain: `anvil` (default) deploys everything on a fresh Anvil and moves its clock through
// every window; `arc-testnet` uses the deployed operator (REHEARSAL_OPERATOR_ADDRESS, deployed in
// REHEARSAL_OPERATOR_DEPLOY_BLOCK) and funded wallets from the environment (packages/server/rehearsal/Chain.ts), in
// real time: (c)'s delivery deadline is four minutes out, and (d), which needs the escrow to expire, is not run.

const release = process.env['VITE_SIDEQUEST_RELEASE'] ?? 'rehearsal'
const mode = process.env['REHEARSAL_CHAIN'] === 'arc-testnet' ? 'arc-testnet' : 'anvil'
const hour = 3600

/**
 * How long (c) waits, after the deadline passed on chain, for the fold to say refunded. On Anvil 300 s, as before. On
 * Arc testnet the refund needs, in turn: the settler's next minute run whose newest confirmed block (three deep, up to
 * ~35 s behind at ~11 s a block) is past the deadline, so up to two runs (120 s); the relayed call's inclusion and
 * three confirmations (6 to 60 s measured on 2026-11-13); the poller's next minute run to record it (60 s); and the
 * read. 420 s covers that sum (~240 s) with a minute's margin twice over.
 */
const refundBudget = mode === 'anvil' ? 300 : 420

/** A fresh secret for the gateway's sealed agent keys, made for the run and never written anywhere. */
const gatewaySecret = Redacted.make(
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, '0')).join(''),
)

const stage = rehearsalStage(release, `local-rehearsal-${mode}-events`, (coreUrl) =>
  gatewayWorker({ coreUrl, release, secret: gatewaySecret }),
)
const { test } = stage

// Anvil's history starts at the operator's deployment; on Arc testnet the poller starts at the operator's own block.
const deployBlock = mode === 'anvil' ? '0' : (process.env['REHEARSAL_OPERATOR_DEPLOY_BLOCK'] ?? '')
const environment = { ...process.env }

const startWorld = Effect.gen(function* () {
  const missing = mode === 'anvil' ? localChainMissing() : undefined
  if (missing !== undefined)
    return yield* Effect.die(new Error(`The rehearsal needs Anvil and the contracts: ${missing}`))
  const chain = yield* Effect.promise(() =>
    mode === 'anvil' ? startAnvil(250_000_000n) : arcTestnetFromEnvironment(environment),
  )
  if (!/^\d+$/u.test(deployBlock))
    return yield* Effect.die(new Error('Arc testnet mode needs REHEARSAL_OPERATOR_DEPLOY_BLOCK'))
  return yield* startEventsWorld(stage, chain, deployBlock, release)
})

const { rehearse, notRun, finish } = rehearsalRun(stage, startWorld)

test(
  '(a) the worker’s agent proposes over MCP; the buyer accepts and funds; the worker’s wallet delivers; approved',
  rehearse('a', 'agent proposes, released on approval with the exact fee', releasedOnApproval),
  { timeout: 900_000 },
)

test(
  '(b) the buyer rejects; a ruling asked for by the arbitration key over NIP-98 splits it: ruled',
  rehearse('b', 'rejected, then ruled through NIP-98', ruledAfterRejection),
  { timeout: 900_000 },
)

// Before (c) and (d), which move Anvil's clock past their escrows' expiry.
test(
  '(e) the worker’s wallet delegates once; the agent delivers over MCP with no wallet signature; approved',
  rehearse('e', 'delivered by the agent’s key under one delegation, approved', releasedAfterDelegatedDelivery),
  { timeout: 900_000 },
)

let undelivered: UndeliveredDeals | undefined
const fundedUndelivered = async (current: EventsWorld) => {
  undelivered ??= await fundUndeliveredDeals(current, mode === 'anvil' ? 2 * hour : 240, mode === 'anvil')
  return undelivered
}

test(
  '(c) funded and never delivered: after the deadline the settler refunds the buyer',
  rehearse('c', 'never delivered, refunded by the settler', async (current) =>
    refundedBySettler(current, await fundedUndelivered(current), refundBudget),
  ),
  { timeout: 1_200_000 },
)

test(
  '(d) settlement withheld until the escrow expires: the buyer reclaims, the fold says reclaimed',
  mode === 'anvil'
    ? rehearse('d', 'settlement withheld until expiry, reclaimed by the buyer', async (current) =>
        reclaimedByBuyer(current, await fundedUndelivered(current)),
      )
    : notRun('d', 'settlement withheld until expiry, reclaimed by the buyer', reclaimNotRun),
  { timeout: 600_000 },
)

test('leaves no relayer transaction unsettled, and writes the evidence', finish, { timeout: 120_000 })
