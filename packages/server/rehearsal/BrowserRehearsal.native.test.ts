import { Effect, type Scope } from 'effect'
import { type BrowserWorld, disputedInBrowser, releasedInBrowser } from './BrowserCases.ts'
import { localChainMissing, startAnvil } from './Chain.ts'
import { evidenceFor } from './Evidence.ts'
import { nostrPerson } from './Nostr.ts'
import { startProxy } from './RpcProxy.ts'
import { chainEvidence, rehearsalRun, rehearsalStage, settlementFor } from './Stage.ts'

// The gate's hire on the website (docs/ROADMAP.md, slice 12): the built website and API in workerd, settled on a fresh
// Anvil exactly as the events rehearsal settles, and two people in Chromium, each with a NIP-07 extension and a test
// wallet, who agree, fund, deliver and approve (a) or reject (b) by clicking what the job page shows. No clock moves:
// the windows that need one are rehearsed by `gate:rehearse:events`. `bun run gate:rehearse:browser` runs it.

const release = process.env['VITE_SIDEQUEST_RELEASE'] ?? 'rehearsal'
const mode = 'anvil'

const stage = rehearsalStage(release, `local-rehearsal-${mode}-browser`)
const { test, deployWith } = stage

/** The chain, its proxy and the stack, deployed with settlement and the stage's arbitration key. */
const startWorld = Effect.gen(function* () {
  const missing = localChainMissing()
  if (missing !== undefined)
    return yield* Effect.die(new Error(`The rehearsal needs Anvil and the contracts: ${missing}`))
  const chain = yield* Effect.promise(() => startAnvil(250_000_000n))
  const proxy = startProxy(chain.rpcUrl, { chainId: 5042002, escrow: chain.escrow, operator: chain.operator })
  const settlement = yield* settlementFor(chain, {
    SIDEQUEST_ARBITRATION_PUBKEY: nostrPerson('arbitration').pubkey,
    // Anvil's history starts at the operator's deployment; a stage names the block its operator was deployed at.
    SIDEQUEST_OPERATOR_DEPLOY_BLOCK: '0',
  })
  const url = yield* deployWith(proxy, settlement)
  const evidence = evidenceFor(`${mode}-browser`, release, chainEvidence(chain), 'phase-2-browser-gate')
  const world: BrowserWorld = { url, chain, proxy, evidence }
  return world
})

const { rehearse, finish } = rehearsalRun(stage, startWorld)

/** A journey in its own browser, closed when it ends, as the rehearsal's cases are promises. */
const inBrowser =
  <A, E>(journey: (world: BrowserWorld) => Effect.Effect<A, E, Scope.Scope>) =>
  (world: BrowserWorld) =>
    Effect.runPromise(Effect.scoped(journey(world)))

test(
  '(a) in two browsers: request, proposal, accept, fund, deliver, approve; the page shows Paid with the exact fee',
  rehearse('a', 'released on the website with the exact fee', inBrowser(releasedInBrowser)),
  { timeout: 900_000 },
)

test(
  '(b) in two browsers: funded and delivered, then rejected with a reason; the page shows the dispute',
  rehearse('b', 'rejected on the website; an arbitrator will rule', inBrowser(disputedInBrowser)),
  { timeout: 900_000 },
)

test('leaves no relayer transaction unsettled, and writes the evidence', finish, { timeout: 120_000 })
