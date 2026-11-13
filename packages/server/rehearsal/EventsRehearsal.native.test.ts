import { LinkedWallet } from '@sidequest/protocol'
import { Effect } from 'effect'
import { localChainMissing, startAnvil } from './Chain.ts'
import { evidenceFor } from './Evidence.ts'
import {
  type EventsWorld,
  fundUndeliveredDeals,
  reclaimedByBuyer,
  refundedBySettler,
  releasedOnApproval,
  ruledAfterRejection,
  type UndeliveredDeals,
} from './EventsCases.ts'
import { anyone, nostrPerson, sign } from './Nostr.ts'
import { startProxy } from './RpcProxy.ts'
import { chainEvidence, rehearsalRun, rehearsalStage, settlementFor } from './Stage.ts'
import { bodyOf, eventually } from './Surfaces.ts'

// The gate rehearsed through signed events (docs/ROADMAP.md, slice 12): two Nostr keys and the wallets they linked
// hire through `POST /api/events` and the sessionless escrow endpoints alone (no sign-in, no session cookie, no MCP;
// agents come back with the gateway slice), on a fresh Anvil whose clock moves through every window. The money's
// stage is read from the index's fold, fed by the chain log poller and settled by the settler on the API Worker's
// Cron Trigger, as on a stage. `bun run gate:rehearse:events` runs it (tools/gate-rehearsal.ts).

const release = process.env['VITE_SIDEQUEST_RELEASE'] ?? 'rehearsal'
const mode = 'anvil'
const hour = 3600

const stage = rehearsalStage(release, `local-rehearsal-${mode}-events`)
const { test, deployWith } = stage

/** Each person links their wallet to their key with a signed event; the index shows the link verified. */
const linkWallet = async (url: string, person: EventsWorld['buyer']) => {
  const api = anyone(url)
  await api.publish(await sign.link(person))
  const linked = await eventually(
    () => api.get(`/api/wallets/${person.account}`),
    (reply) => reply.status === 200,
  )
  const link = bodyOf(LinkedWallet, linked, `${person.name}'s wallet`)
  if (link.pubkey !== person.pubkey || link.verification !== 'verified') throw new Error('The link is not verified')
}

/**
 * The chain, the proxy and the stack, deployed once with settlement, the stage's arbitration key and the operator's
 * deployment block, and the two people with their wallets linked.
 */
const startWorld = Effect.gen(function* () {
  const missing = localChainMissing()
  if (missing !== undefined)
    return yield* Effect.die(new Error(`The rehearsal needs Anvil and the contracts: ${missing}`))
  const chain = yield* Effect.promise(() => startAnvil(250_000_000n))
  const proxy = startProxy(chain.rpcUrl, { chainId: 5042002, escrow: chain.escrow, operator: chain.operator })
  const arbitration = nostrPerson('arbitration')
  const settlement = yield* settlementFor(chain, {
    SIDEQUEST_ARBITRATION_PUBKEY: arbitration.pubkey,
    // Anvil's history starts at the operator's deployment; a stage names the block its operator was deployed at.
    SIDEQUEST_OPERATOR_DEPLOY_BLOCK: '0',
  })
  const url = yield* deployWith(proxy, settlement)
  const buyer = nostrPerson('buyer', chain.keys.buyer)
  const worker = nostrPerson('worker', chain.keys.worker)
  yield* Effect.promise(async () => chain.mint?.(buyer.wallet.address, 4n * chain.amount))
  yield* Effect.promise(() => linkWallet(url, buyer))
  yield* Effect.promise(() => linkWallet(url, worker))
  const evidence = evidenceFor(
    `${mode}-events`,
    release,
    {
      ...chainEvidence(chain),
      buyer: buyer.wallet.address,
      buyerKey: buyer.pubkey,
      worker: worker.wallet.address,
      workerKey: worker.pubkey,
      arbitrationKey: arbitration.pubkey,
    },
    'phase-2-events-gate',
  )
  const world: EventsWorld = { url, chain, proxy, buyer, worker, arbitration, evidence }
  return world
})

const { rehearse, finish } = rehearsalRun(stage, startWorld)

test(
  '(a) request, proposal, accept, fund, delivery note and delivery, approval: released with the exact fee',
  rehearse('a', 'released on approval with the exact fee', releasedOnApproval),
  { timeout: 600_000 },
)

test(
  '(b) the buyer rejects; a ruling asked for by the arbitration key over NIP-98 splits it: ruled',
  rehearse('b', 'rejected, then ruled through NIP-98', ruledAfterRejection),
  { timeout: 600_000 },
)

let undelivered: UndeliveredDeals | undefined
const fundedUndelivered = async (current: EventsWorld) => {
  undelivered ??= await fundUndeliveredDeals(current, 2 * hour)
  return undelivered
}

test(
  '(c) funded and never delivered: after the deadline the settler refunds the buyer',
  rehearse('c', 'never delivered, refunded by the settler', async (current) =>
    refundedBySettler(current, await fundedUndelivered(current)),
  ),
  { timeout: 900_000 },
)

test(
  '(d) settlement withheld until the escrow expires: the buyer reclaims, the fold says reclaimed',
  rehearse('d', 'settlement withheld until expiry, reclaimed by the buyer', async (current) =>
    reclaimedByBuyer(current, await fundedUndelivered(current)),
  ),
  { timeout: 600_000 },
)

test('leaves no relayer transaction unsettled, and writes the evidence', finish, { timeout: 120_000 })
