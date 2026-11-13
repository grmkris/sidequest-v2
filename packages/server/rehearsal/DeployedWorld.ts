import { SecretKey } from '@sidequest/nostr'
import { Status } from '@sidequest/protocol'
import { sidequestOperatorAbi } from '@sidequest/settlement/abi/SidequestOperator'
import { arcTestnetEscrow } from '@sidequest/settlement/SettlementChain'
import { Option, Schema } from 'effect'
import { type Address, getAddress, type PublicClient } from 'viem'
import { arcTestnetReads, keyIn, required } from './Chain.ts'
import { evidenceFor, step } from './Evidence.ts'
import type { GateWorld, Pace } from './GateCases.ts'
import { gatewayAgent } from './GatewayAgent.ts'
import { linkWallet, partiesEvidence } from './GateWorld.ts'
import { nostrPerson } from './Nostr.ts'
import { observeStage, type StageCalls } from './StageCalls.ts'

// The gate against a stage already deployed on Cloudflare, which the rehearsal deploys nothing to: it uses the stage
// exactly as an outsider would, over the core's public API (`POST /api/events`, the index's reads, the escrow
// endpoints), the gateway's operator API through the core's `/gateway` proxy (as the website calls it), and OAuth and
// MCP at the gateway's own URL. The stage holds its own relayer and arbitrator keys and reaches the chain itself; the
// rehearsal holds only the buyer's and the worker's wallet keys, reads the chain for balances and confirmations, and
// makes fresh Nostr keys for both people. `REHEARSAL_ARBITRATION_NOSTR_KEY`, the stage's arbitration key, is optional:
// without it the ruling case is not run.

/** What the gateway's `/status` answers. */
const GatewayStatus = Schema.Struct({
  service: Schema.Literal('sidequest-gateway'),
  status: Schema.Literal('ok'),
  release: Schema.String,
})

/**
 * Reading a deployed stage: every 2 s (well inside its limits), and 180 s for a chain fact the chain confirmed. The
 * chain log poller runs on the API Worker's minute Cron Trigger, which Cloudflare fires within the minute but may start
 * some seconds late; it records a log once the log's block is three deep, which the rehearsal already waited for. So a
 * fact shows by the poller's next run (at most 60 s plus that delay) and the next read (2 s); 180 s allows a missed run
 * and a slow read beside it, and a fact that has not shown by then is the stage's failure, not the chain's.
 */
export const deployedPace: Pace = { readMillis: 2000, factSeconds: 180 }

/** The world of a deployed stage: no node proxy, and every request to the stage observed. */
export interface DeployedWorld extends GateWorld {
  readonly gatewayUrl: string
  readonly calls: StageCalls
}

type Environment = Readonly<Record<string, string | undefined>>

/** An `https` origin from the environment: a host, no path. */
const originIn = (environment: Environment, name: string) => {
  const value = required(environment, name).trim().replace(/\/$/u, '')
  if (!/^https:\/\/[^\s/?#]+$/u.test(value)) throw new Error(`${name} is not an https origin: ${value}`)
  return value
}

/** What `url` answers, as `schema` reads it; refuses a target that does not answer as expected. */
const answerOf = async <A>(schema: Schema.Decoder<A>, url: string, what: string): Promise<A> => {
  const response = await fetch(url)
  const body: unknown = await response.json().catch(() => undefined)
  const decoded = Schema.decodeUnknownOption(schema)(body)
  if (Option.isNone(decoded))
    throw new Error(`Refusing ${url}: ${what} answered ${response.status} ${JSON.stringify(body)}`)
  return decoded.value
}

/** The operator as the chain has it: its escrow must be Arc testnet's and its fee 500 bps; answers its fee receiver. */
const feeReceiverOf = async (client: PublicClient, operator: Address) => {
  const read = <F extends 'ESCROW' | 'FEE_BPS' | 'FEE_RECEIVER'>(functionName: F) =>
    client.readContract({ address: operator, abi: sidequestOperatorAbi, functionName })
  const [escrow, feeBps, feeReceiver] = await Promise.all([read('ESCROW'), read('FEE_BPS'), read('FEE_RECEIVER')])
  if (getAddress(escrow) !== arcTestnetEscrow) throw new Error(`The operator ${operator} uses escrow ${escrow}`)
  if (feeBps !== 500) throw new Error(`The operator ${operator} takes ${feeBps} bps, the cases expect 500`)
  return getAddress(feeReceiver)
}

/** The stage's arbitration key, when given; refused, never shown, when it is not one. */
const arbitrationKeyIn = (environment: Environment) => {
  const value = environment['REHEARSAL_ARBITRATION_NOSTR_KEY']
  if (value === undefined || value.trim() === '') return undefined
  const key = Schema.decodeUnknownOption(SecretKey)(value.trim())
  if (Option.isNone(key)) throw new Error('REHEARSAL_ARBITRATION_NOSTR_KEY is not a Nostr secret key (64 hex digits)')
  return key.value
}

/** Checks the target and the chain, refusing any other service or chain, then makes the people and the agent. */
export const startDeployedWorld = async (environment: Environment): Promise<DeployedWorld> => {
  if (environment['REHEARSAL_CHAIN'] !== 'arc-testnet')
    throw new Error('A deployed stage is rehearsed on Arc testnet only: set REHEARSAL_CHAIN=arc-testnet')
  const url = originIn(environment, 'REHEARSAL_TARGET')
  const gatewayUrl = originIn(environment, 'REHEARSAL_GATEWAY')
  const buyer = nostrPerson('buyer', keyIn(environment, 'REHEARSAL_BUYER_KEY'))
  const worker = nostrPerson('worker', keyIn(environment, 'REHEARSAL_WORKER_KEY'))
  const arbitrationKey = arbitrationKeyIn(environment)
  const arbitration = arbitrationKey === undefined ? undefined : nostrPerson('arbitration', undefined, arbitrationKey)
  const calls = observeStage([new URL(url).host, new URL(gatewayUrl).host])
  try {
    const core = await answerOf(Status, `${url}/api/status`, 'its status (sidequest-v2)')
    const gateway = await answerOf(GatewayStatus, `${gatewayUrl}/status`, 'its status (sidequest-gateway)')
    const proxied = await fetch(`${url}/gateway/api/agents`)
    if (proxied.status !== 401)
      throw new Error(`Refusing ${url}: its /gateway proxy answered ${proxied.status}, not the gateway's 401`)
    const chain = await arcTestnetReads(environment, feeReceiverOf)
    const needed = BigInt(arbitration === undefined ? 3 : 4) * chain.amount
    const held = await chain.balanceOf(buyer.wallet.address)
    if (held < needed) throw new Error(`The buyer's wallet holds ${held}, the run funds ${needed} (atomic units)`)
    await linkWallet(url, buyer)
    await linkWallet(url, worker)
    const workerAgent = await gatewayAgent(url, gatewayUrl, worker, ['propose', 'deliver'], `${url}/gateway`)
    const evidence = evidenceFor(
      'arc-testnet-deployed',
      core.release,
      {
        chainId: 5042002,
        escrow: chain.escrow,
        token: chain.token,
        operator: chain.operator,
        treasury: chain.treasury,
        amount: String(chain.amount),
        ...partiesEvidence({ buyer, worker, workerAgent, arbitration }),
      },
      'phase-2-deployed-gate',
    )
    evidence.stage = {
      target: url,
      gateway: gatewayUrl,
      release: core.release,
      protocolVersion: core.protocolVersion,
      gatewayRelease: gateway.release,
    }
    step(evidence, {
      case: 'setup',
      step: 'the target answered as sidequest-v2 and its gateway as sidequest-gateway; both wallets linked; the worker made an agent through the /gateway proxy (NIP-98), granted it and connected an MCP client over OAuth',
      detail: { release: core.release, gatewayRelease: gateway.release },
    })
    return {
      url,
      gatewayUrl,
      chain,
      proxy: undefined,
      buyer,
      worker,
      workerAgent,
      arbitration,
      pace: deployedPace,
      evidence,
      calls,
    }
  } catch (cause) {
    calls.stop()
    throw cause
  }
}
