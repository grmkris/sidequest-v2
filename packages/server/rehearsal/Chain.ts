import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { UsdcOnArcTestnet } from '@sidequest/protocol'
import { arcTestnetCollector, arcTestnetEscrow, arcTestnetUsdcDomain } from '@sidequest/settlement/SettlementChain'
import { Schema } from 'effect'
import {
  type Address,
  createPublicClient,
  encodeFunctionData,
  getAddress,
  getContractAddress,
  type Hex,
  http,
  isHex,
  parseAbi,
  type PublicClient,
} from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

// The chain a rehearsal runs on. `anvil` (the default): a fresh Anvil with Arc testnet's chain id, the Foundry build of
// the audited escrow and its collector, commerce-payments' ERC-3009 mock at Arc's USDC address, and `SidequestOperator`
// deployed by its real deploy script; every key generated for the run, every window passed by moving Anvil's clock.
// `arc-testnet`: the deployed escrow, collector, USDC and an operator someone deployed, with funded test keys from the
// environment (see `arcTestnetFromEnvironment`); no clock to move, so the cases that need one are reported, not run.

const contracts = new URL('../../../contracts/', import.meta.url)
const artifacts = {
  escrow: 'out/AuthCaptureEscrow.sol/AuthCaptureEscrow.json',
  collector: 'out/ERC3009PaymentCollector.sol/ERC3009PaymentCollector.json',
  token: 'out/MockERC3009Token.sol/MockERC3009Token.json',
  operator: 'out/SidequestOperator.sol/SidequestOperator.json',
} as const

/** The keys one run uses. Never printed, never written: the evidence names addresses only. */
export interface Keys {
  readonly relayer: Hex
  readonly arbitrator: Hex
  readonly buyer: Hex
  readonly worker: Hex
  /** The person allowed to issue rulings (the arbitration operator); holds no funds. */
  readonly arbitration: Hex
}

export interface RehearsalChain {
  readonly mode: 'anvil' | 'arc-testnet'
  /** Where the chain answers; the stack reaches it only through the rehearsal's proxy. */
  readonly rpcUrl: string
  readonly client: PublicClient
  readonly escrow: Address
  readonly collector: Address
  readonly token: Address
  readonly tokenDomain: { readonly name: string; readonly version: string }
  readonly operator: Address
  readonly treasury: Address
  readonly confirmations: number
  /** The job amount, in the token's atomic units. */
  readonly amount: bigint
  readonly keys: Keys
  readonly balanceOf: (owner: Address) => Promise<bigint>
  /** Give `to` the token, where the rehearsal can (the local mock lets anyone mint); on Arc the keys come funded. */
  readonly mint: ((to: Address, amount: bigint) => Promise<void>) | undefined
  readonly now: () => Promise<number>
  /** Move the chain's clock forward and mine a block; undefined where the clock cannot be moved. */
  readonly advance: ((seconds: number) => Promise<void>) | undefined
  readonly stop: () => void
}

const tokenAbi = parseAbi([
  'function mint(address to, uint256 amount)',
  'function balanceOf(address owner) view returns (uint256)',
])

const Artifact = Schema.Struct({
  bytecode: Schema.Struct({ object: Schema.String }),
  deployedBytecode: Schema.Struct({ object: Schema.String }),
})
const code = (name: keyof typeof artifacts, part: 'bytecode' | 'deployedBytecode'): Hex => {
  const value = Schema.decodeUnknownSync(Schema.fromJsonString(Artifact))(
    readFileSync(new URL(artifacts[name], contracts), 'utf8'),
  )[part].object
  if (!isHex(value)) throw new Error(`${name} has no ${part}`)
  return value
}

/** Why the local chain cannot start here, if it cannot. */
export const localChainMissing = () => {
  if (spawnSync('anvil', ['--version'], { stdio: 'ignore' }).status !== 0) return 'anvil is not on PATH'
  if (spawnSync('forge', ['--version'], { stdio: 'ignore' }).status !== 0) return 'forge is not on PATH'
  const unbuilt = Object.values(artifacts).filter((file) => !existsSync(new URL(file, contracts)))
  return unbuilt.length === 0 ? undefined : `contracts/ is not built (${unbuilt.join(', ')} missing)`
}

/** A port nothing listens on now: the one a throwaway server was given. */
const freePort = async () => {
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(null) })
  const { port } = probe
  await probe.stop(true)
  return port
}

/** One JSON-RPC call, for Anvil's own methods, which viem's public actions do not type. */
const rpc = async (url: string, method: string, params: ReadonlyArray<unknown>) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const answer: unknown = await response.json()
  if (!response.ok || (typeof answer === 'object' && answer !== null && 'error' in answer))
    throw new Error(`${method} failed: ${JSON.stringify(answer)}`)
  return answer
}

/** Anvil answers once it listens: ask for the chain id until it does, for at most ten seconds. */
const ready = async (client: PublicClient) => {
  const until = Date.now() + 10_000
  while (
    !(await client.getChainId().then(
      () => true,
      () => false,
    ))
  ) {
    if (Date.now() > until) throw new Error('Anvil did not start')
    await Bun.sleep(50)
  }
}

const word = (value: string) => value.toLowerCase().replace(/^0x/, '').padStart(64, '0')

/** Deploy from an address Anvil impersonates: no key involved. Returns the contract's address. */
const deployFrom = async (url: string, client: PublicClient, from: Address, data: Hex) => {
  const answer = await rpc(url, 'eth_sendTransaction', [{ from, data, gas: '0x1c9c380' }])
  const hash = Schema.decodeUnknownSync(Schema.Struct({ result: Schema.String }))(answer).result
  if (!isHex(hash)) throw new Error('No transaction hash')
  const receipt = await client.waitForTransactionReceipt({ hash })
  if (receipt.contractAddress == null) throw new Error('Nothing was deployed')
  return getAddress(receipt.contractAddress)
}

/** `SidequestOperator` through its own deploy script, broadcast from an impersonated deployer. */
const deployOperator = (url: string, deployer: Address, escrow: Address, collector: Address, treasury: Address) => {
  const run = spawnSync(
    'forge',
    [
      'script',
      'script/DeploySidequestOperator.s.sol',
      '--rpc-url',
      url,
      '--broadcast',
      '--unlocked',
      '--sender',
      deployer,
    ],
    {
      cwd: new URL('.', contracts),
      encoding: 'utf8',
      env: {
        ...process.env,
        SIDEQUEST_FEE_RECEIVER: treasury,
        AUTH_CAPTURE_ESCROW: escrow,
        ERC3009_PAYMENT_COLLECTOR: collector,
      },
    },
  )
  if (run.status !== 0) throw new Error(`The deploy script failed:\n${run.stdout}\n${run.stderr}`)
  // The script's only transaction is the deployer's first: the operator is at the deployer's nonce-0 address.
  return getContractAddress({ from: deployer, nonce: 0n })
}

/** The escrow, its collector and the mock USDC at Arc's USDC address, deployed by `deployer`. */
const deployEscrow = async (url: string, client: PublicClient, deployer: Address) => {
  const escrow = await deployFrom(url, client, deployer, code('escrow', 'bytecode'))
  const collector = await deployFrom(
    url,
    client,
    deployer,
    `${code('collector', 'bytecode')}${word(escrow)}${word('0xca11')}`,
  )
  await rpc(url, 'anvil_setCode', [usdc, code('token', 'deployedBytecode')])
  return { escrow, collector }
}

const usdc = getAddress(UsdcOnArcTestnet.id.slice(UsdcOnArcTestnet.id.lastIndexOf(':') + 1))

const fundGas = (url: string, address: Address) => rpc(url, 'anvil_setBalance', [address, '0x56bc75e2d63100000'])

const generatedKeys = (): Keys => ({
  relayer: generatePrivateKey(),
  arbitrator: generatePrivateKey(),
  buyer: generatePrivateKey(),
  worker: generatePrivateKey(),
  arbitration: generatePrivateKey(),
})

/**
 * Start Anvil with Arc testnet's chain id and deploy everything a hire needs, from fresh addresses Anvil impersonates
 * (no key involved): one deploys the escrow and collector, then the other runs the operator's deploy script, which
 * refuses dependency addresses without code.
 */
export const startAnvil = async (amount: bigint): Promise<RehearsalChain> => {
  const port = await freePort()
  const anvil = spawn('anvil', ['--port', String(port), '--chain-id', '5042002', '--silent'], { stdio: 'ignore' })
  const url = `http://127.0.0.1:${port}`
  const client = createPublicClient({ transport: http(url, { retryCount: 0 }) })
  try {
    await ready(client)
    const keys = generatedKeys()
    const deployer = privateKeyToAccount(generatePrivateKey()).address
    const treasury = privateKeyToAccount(generatePrivateKey()).address
    await rpc(url, 'anvil_impersonateAccount', [deployer])
    await fundGas(url, deployer)
    const helper = privateKeyToAccount(generatePrivateKey()).address
    await rpc(url, 'anvil_impersonateAccount', [helper])
    await fundGas(url, helper)
    const { escrow, collector } = await deployEscrow(url, client, helper)
    const operator = deployOperator(url, deployer, escrow, collector, treasury)
    if ((await client.getCode({ address: operator })) === undefined) throw new Error('The operator did not deploy')
    for (const key of [keys.relayer, keys.buyer, keys.worker]) await fundGas(url, privateKeyToAccount(key).address)
    const token = usdc
    return {
      mode: 'anvil',
      rpcUrl: url,
      client,
      escrow,
      collector,
      token,
      // The mock token: Solady's ERC20 named "USD Coin", with Solady's default version, "1".
      tokenDomain: { name: 'USD Coin', version: '1' },
      operator,
      treasury,
      confirmations: 1,
      amount,
      keys,
      balanceOf: (owner) =>
        client.readContract({ address: token, abi: tokenAbi, functionName: 'balanceOf', args: [owner] }),
      mint: async (to, value) => {
        const data = encodeFunctionData({ abi: tokenAbi, functionName: 'mint', args: [to, value] })
        const answer = await rpc(url, 'eth_sendTransaction', [{ from: helper, to: token, data }])
        const hash = Schema.decodeUnknownSync(Schema.Struct({ result: Schema.String }))(answer).result
        if (isHex(hash)) await client.waitForTransactionReceipt({ hash })
      },
      now: async () => Number((await client.getBlock()).timestamp),
      advance: async (seconds) => {
        await rpc(url, 'evm_increaseTime', [seconds])
        await rpc(url, 'evm_mine', [])
      },
      stop: () => anvil.kill(),
    }
  } catch (cause) {
    anvil.kill()
    throw cause
  }
}

const required = (environment: Readonly<Record<string, string | undefined>>, name: string) => {
  const value = environment[name]
  if (value === undefined || value.length === 0) throw new Error(`Arc testnet mode needs ${name}`)
  return value
}
const keyIn = (environment: Readonly<Record<string, string | undefined>>, name: string): Hex => {
  const value = required(environment, name)
  if (!isHex(value) || value.length !== 66) throw new Error(`${name} is not a private key (0x and 64 hex digits)`)
  return value
}

/**
 * Arc testnet, from the environment: `ARC_TESTNET_RPC_URL`, the deployed `REHEARSAL_OPERATOR_ADDRESS` and its
 * `REHEARSAL_TREASURY_ADDRESS` (its immutable fee receiver), and five keys for the run: `REHEARSAL_RELAYER_KEY` (pays
 * gas), `REHEARSAL_ARBITRATOR_KEY`, `REHEARSAL_BUYER_KEY` (holds the amount three times over, plus gas),
 * `REHEARSAL_WORKER_KEY` and `REHEARSAL_ARBITRATION_KEY` (signs in only). Optional: `REHEARSAL_AMOUNT` (atomic units,
 * default 100000, 0.1 USDC) and `REHEARSAL_CONFIRMATIONS` (default 3). It refuses any chain id but Arc testnet's.
 */
export const arcTestnetFromEnvironment = async (
  environment: Readonly<Record<string, string | undefined>>,
): Promise<RehearsalChain> => {
  const url = required(environment, 'ARC_TESTNET_RPC_URL')
  const client = createPublicClient({ transport: http(url, { retryCount: 2 }) })
  const chainId = await client.getChainId()
  if (chainId !== 5042002) throw new Error(`ARC_TESTNET_RPC_URL answers chain ${chainId}, not Arc testnet (5042002)`)
  const token = usdc
  return {
    mode: 'arc-testnet',
    rpcUrl: url,
    client,
    escrow: arcTestnetEscrow,
    collector: arcTestnetCollector,
    token,
    tokenDomain: arcTestnetUsdcDomain,
    operator: getAddress(required(environment, 'REHEARSAL_OPERATOR_ADDRESS')),
    treasury: getAddress(required(environment, 'REHEARSAL_TREASURY_ADDRESS')),
    confirmations: Number(environment['REHEARSAL_CONFIRMATIONS'] ?? '3'),
    amount: BigInt(environment['REHEARSAL_AMOUNT'] ?? '100000'),
    keys: {
      relayer: keyIn(environment, 'REHEARSAL_RELAYER_KEY'),
      arbitrator: keyIn(environment, 'REHEARSAL_ARBITRATOR_KEY'),
      buyer: keyIn(environment, 'REHEARSAL_BUYER_KEY'),
      worker: keyIn(environment, 'REHEARSAL_WORKER_KEY'),
      arbitration: keyIn(environment, 'REHEARSAL_ARBITRATION_KEY'),
    },
    balanceOf: (owner) =>
      client.readContract({ address: token, abi: tokenAbi, functionName: 'balanceOf', args: [owner] }),
    mint: undefined,
    now: async () => Number((await client.getBlock()).timestamp),
    advance: undefined,
    stop: () => undefined,
  }
}
