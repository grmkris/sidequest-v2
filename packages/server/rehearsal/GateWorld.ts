import { LinkedWallet } from '@sidequest/protocol'
import { Effect } from 'effect'
import type { RehearsalChain } from './Chain.ts'
import { evidenceFor } from './Evidence.ts'
import { type GateWorld, localPace } from './GateCases.ts'
import { gatewayAgent } from './GatewayAgent.ts'
import { anyone, type NostrPerson, nostrPerson, sign } from './Nostr.ts'
import { type RpcProxy, startProxy } from './RpcProxy.ts'
import { chainEvidence, type rehearsalStage, settlementFor } from './Stage.ts'
import { bodyOf, eventually } from './Surfaces.ts'

// The world of the gate rehearsal: the chain, the core and the agent gateway deployed together in workerd, the buyer
// and the worker as fresh Nostr keys with their wallets linked, and the worker's agent at the gateway, granted and
// connected over OAuth. Every Nostr key is made for the run; the wallets are the chain's keys.

/** The world of a stack the rehearsal deployed: the chain with the stack's keys, and the node proxy before it. */
export interface LocalGateWorld extends GateWorld {
  readonly chain: RehearsalChain
  readonly proxy: RpcProxy
}

/** Each person links their wallet to their key with a signed event; the index shows the link verified. */
export const linkWallet = async (url: string, person: NostrPerson) => {
  const api = anyone(url)
  await api.publish(await sign.link(person))
  const linked = await eventually(
    () => api.get(`/api/wallets/${person.account}`),
    (reply) => reply.status === 200,
  )
  const link = bodyOf(LinkedWallet, linked, `${person.name}'s wallet`)
  if (link.pubkey !== person.pubkey || link.verification !== 'verified') throw new Error('The link is not verified')
}

/** The people, the worker's agent and the arbitration key, by address and public key, for the evidence. */
export const partiesEvidence = (
  world: Pick<GateWorld, 'buyer' | 'worker' | 'workerAgent' | 'arbitration'>,
): Readonly<Record<string, string>> => ({
  buyer: world.buyer.wallet.address,
  buyerKey: world.buyer.pubkey,
  worker: world.worker.wallet.address,
  workerKey: world.worker.pubkey,
  workerAgentKey: world.workerAgent.pubkey,
  workerAgentGrant: world.workerAgent.grant,
  workerAgentScopes: world.workerAgent.scopes.join(' '),
  workerAgentDelegate: world.workerAgent.delegate,
  arbitrationKey: world.arbitration?.pubkey ?? 'not given',
})

/** How many jobs a run funds: (a), (b), (e) and (c), and (d) where it runs. */
const fundedJobs = (chain: RehearsalChain) => (chain.mode === 'anvil' ? 5n : 4n)

/**
 * Deploys the stack on `chain` with settlement, a fresh arbitration key and the operator's deployment block
 * (`deployBlock`: where the chain log poller starts), and makes the people and the worker's agent.
 */
export const startGateWorld = (
  stage: ReturnType<typeof rehearsalStage>,
  chain: RehearsalChain,
  deployBlock: string,
  release: string,
) =>
  Effect.gen(function* () {
    const proxy = startProxy(chain.rpcUrl, { chainId: 5042002, escrow: chain.escrow, operator: chain.operator })
    const arbitration = nostrPerson('arbitration')
    const settlement = yield* settlementFor(chain, {
      SIDEQUEST_ARBITRATION_PUBKEY: arbitration.pubkey,
      SIDEQUEST_OPERATOR_DEPLOY_BLOCK: deployBlock,
    })
    const { url, gatewayUrl } = yield* stage.deployBesideWith(proxy, settlement)
    const buyer = nostrPerson('buyer', chain.keys.buyer)
    const worker = nostrPerson('worker', chain.keys.worker)
    const needed = fundedJobs(chain) * chain.amount
    yield* Effect.promise(async () => chain.mint?.(buyer.wallet.address, needed))
    const held = yield* Effect.promise(() => chain.balanceOf(buyer.wallet.address))
    if (held < needed)
      return yield* Effect.die(new Error(`The buyer's wallet holds ${held}, the run funds ${needed} (atomic units)`))
    yield* Effect.promise(() => linkWallet(url, buyer))
    yield* Effect.promise(() => linkWallet(url, worker))
    const workerAgent = yield* Effect.promise(() => gatewayAgent(url, gatewayUrl, worker, ['propose', 'deliver']))
    const evidence = evidenceFor(
      chain.mode,
      release,
      {
        ...chainEvidence(chain),
        deployBlock,
        ...partiesEvidence({ buyer, worker, workerAgent, arbitration }),
      },
      'phase-2-events-gate',
    )
    const world: LocalGateWorld = {
      url,
      chain,
      proxy,
      buyer,
      worker,
      workerAgent,
      arbitration,
      pace: localPace,
      evidence,
    }
    return world
  })
