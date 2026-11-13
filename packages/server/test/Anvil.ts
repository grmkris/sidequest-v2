import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { erc8004RegistriesOf } from '@sidequest/settlement/Erc8004'
import { arcTestnet, type SettlementChain } from '@sidequest/settlement/SettlementChain'
import { chainProfiles } from '@sidequest/settlement/Chains'
import { Option, Redacted, Schema } from 'effect'
import {
  type Address,
  createPublicClient,
  createWalletClient,
  type Hex,
  http,
  isAddress,
  isHex,
  parseAbi,
  type PublicClient,
  type TransactionReceipt,
} from 'viem'
import { type PrivateKeyAccount, privateKeyToAccount } from 'viem/accounts'
import { afterAll, beforeAll } from 'vitest'
import type { SettlementConfig } from '../src/Settlement/SettlementConfig.ts'

// A local chain for the tests that need one: Anvil with Arc testnet's chain id, the real `AuthCaptureEscrow` v1.1, its
// `ERC3009PaymentCollector` and `SidequestOperator` from the Foundry build, commerce-payments' ERC-3009 mock token
// placed at Arc's USDC address, and the local ERC-8004 registries (`contracts/test/erc8004`) placed at the addresses
// they have on Arc testnet. Available only where `anvil` runs and `contracts/out` holds the build
// (`forge soldeer install && forge build` in `contracts/`); elsewhere those tests skip with a notice, and in CI they
// fail instead, so CI can never pass without running them.

const out = new URL('../../../contracts/out/', import.meta.url)
const artifacts = {
  escrow: 'AuthCaptureEscrow.sol/AuthCaptureEscrow.json',
  collector: 'ERC3009PaymentCollector.sol/ERC3009PaymentCollector.json',
  token: 'MockERC3009Token.sol/MockERC3009Token.json',
  operator: 'SidequestOperator.sol/SidequestOperator.json',
  identityRegistry: 'Erc8004Registries.sol/Erc8004IdentityRegistry.json',
  reputationRegistry: 'Erc8004Registries.sol/Erc8004ReputationRegistry.json',
} as const

/** Why the tests on Anvil cannot run here, if they cannot: Anvil missing, or the contracts not built. */
export const anvilMissing = (() => {
  if (spawnSync('anvil', ['--version'], { stdio: 'ignore' }).status !== 0) return 'anvil is not on PATH'
  const unbuilt = Object.values(artifacts).filter((file) => !existsSync(new URL(file, out)))
  return unbuilt.length === 0 ? undefined : `contracts/out lacks ${unbuilt.join(', ')}`
})()

const inCi = process.env['CI'] !== undefined
const unavailable =
  anvilMissing === undefined
    ? undefined
    : `${anvilMissing}: install Foundry 1.8.3 and run \`forge soldeer install && forge build\` in contracts/`

/** Whether suites on Anvil skip here: they cannot run, and this is not CI. */
export const skipOnChain = unavailable !== undefined && !inCi

/**
 * Call first inside a suite that runs on Anvil (`describe.skipIf(skipOnChain)`). Where the suite skips, it says so on
 * stderr, naming the suite and why; in CI (`CI` set, as GitHub Actions sets it) the suite runs and fails with the
 * reason instead, so CI never passes without it.
 */
export const onChainOnly = (suite: string) => {
  if (skipOnChain) process.stderr.write(`\nSKIPPED "${suite}", every test in it: ${unavailable}.\n\n`)
  beforeAll(() => {
    if (unavailable !== undefined) throw new Error(`CI must run "${suite}" on Anvil, but ${unavailable}`)
  })
}

/**
 * Anvil for the enclosing suite (`describe.skipIf(skipOnChain)`): started before its tests, stopped after them, with
 * `onChainOnly`'s notice or failure. Answers the running chain, for tests to read.
 */
export const suiteChain = (suite: string) => {
  onChainOnly(suite)
  let started: LocalChain | undefined
  beforeAll(async () => {
    started = await startChain()
  }, 60_000)
  afterAll(() => started?.stop())
  return (): LocalChain => {
    if (started === undefined) throw new Error(`${suite}: Anvil did not start`)
    return started
  }
}

const Artifact = Schema.Struct({
  bytecode: Schema.Struct({ object: Schema.String }),
  deployedBytecode: Schema.Struct({ object: Schema.String }),
})
const code = (name: keyof typeof artifacts, part: 'bytecode' | 'deployedBytecode'): Hex => {
  const value = Schema.decodeUnknownSync(Schema.fromJsonString(Artifact))(
    readFileSync(new URL(artifacts[name], out), 'utf8'),
  )[part].object
  if (!isHex(value)) throw new Error(`${name} has no ${part}`)
  return value
}

// Anvil's well-known development keys: a deployer, the relayer and the interim arbitrator.
const deployer = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
const relayerKey: Hex = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const arbitratorKey: Hex = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3ba3d4e6e1b7e0bf'
const treasury: Address = '0x000000000000000000000000000000000007ea50'
const usdc: Address = '0x3600000000000000000000000000000000000000'

/** One ABI word of a constructor argument: an address or a number in hex, left-padded. */
const word = (value: string) => value.toLowerCase().replace(/^0x/, '').padStart(64, '0')

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() =>
        typeof address === 'object' && address !== null ? resolve(address.port) : reject(new Error('No port')),
      )
    })
  })

const ready = async (client: PublicClient) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const answered = await client.getChainId().then(
      () => true,
      () => false,
    )
    if (answered) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('Anvil did not start')
}

const initializeAbi = parseAbi(['function initialize(address identityRegistry)'])

const tokenAbi = parseAbi([
  'function mint(address to, uint256 amount)',
  'function balanceOf(address owner) view returns (uint256)',
])

export interface LocalChain {
  /** Anvil's JSON-RPC URL, for a test that sends its own transactions or calls Anvil's own methods. */
  readonly url: string
  readonly client: PublicClient
  /** Settlement on this chain, every confirmation counting at once. */
  readonly config: SettlementConfig
  readonly chain: SettlementChain
  readonly treasury: Address
  readonly mint: (to: Address, amount: bigint) => Promise<void>
  readonly balanceOf: (owner: Address) => Promise<bigint>
  /** Move the chain's clock forward and mine a block. */
  readonly advance: (seconds: number) => Promise<void>
  readonly now: () => Promise<number>
  /** `account` sends a transaction (given gas money first) and waits for it to be mined; answers its receipt. */
  readonly send: (
    account: PrivateKeyAccount,
    transaction: { readonly to: string; readonly data: string },
  ) => Promise<TransactionReceipt>
  readonly stop: () => void
}

/**
 * The local ERC-8004 registries' runtime code at the addresses the reference deployment has on Arc testnet, as there
 * with no constructor run, and the reputation registry initialised with the identity registry, through `write`.
 */
const installErc8004 = async (
  anvilCall: (method: string, params: ReadonlyArray<unknown>) => Promise<void>,
  write: (call: {
    readonly address: Address
    readonly abi: typeof initializeAbi
    readonly functionName: 'initialize'
    readonly args: readonly [Address]
  }) => Promise<unknown>,
) => {
  const { identity, reputation } = erc8004RegistriesOf(chainProfiles['arc-testnet'])
  await anvilCall('anvil_setCode', [identity, code('identityRegistry', 'deployedBytecode')])
  await anvilCall('anvil_setCode', [reputation, code('reputationRegistry', 'deployedBytecode')])
  await write({ address: reputation, abi: initializeAbi, functionName: 'initialize', args: [identity] })
}

/** A test wallet's transaction on Anvil, given gas money first, mined; answers its receipt. */
const sendingOn =
  (
    client: PublicClient,
    transport: ReturnType<typeof http>,
    anvilCall: (method: string, params: ReadonlyArray<unknown>) => Promise<void>,
  ): LocalChain['send'] =>
  async (account, { to, data }) => {
    if (!isAddress(to) || !isHex(data)) throw new Error('Not a transaction')
    await anvilCall('anvil_setBalance', [account.address, '0xde0b6b3a7640000'])
    const sender = createWalletClient({ account, transport })
    return client.waitForTransactionReceipt({ hash: await sender.sendTransaction({ to, data, chain: null }) })
  }

/** Start Anvil and deploy the escrow, the collector, the operator and the token, and place the ERC-8004 registries. */
export const startChain = async (): Promise<LocalChain> => {
  const port = await freePort()
  const anvil: ChildProcess = spawn('anvil', ['--port', String(port), '--chain-id', '5042002', '--silent'], {
    stdio: 'ignore',
  })
  const url = `http://127.0.0.1:${port}`
  const transport = http(url, { retryCount: 0 })
  /** Anvil's own methods, which viem's public actions do not type. */
  const anvilCall = async (method: string, params: ReadonlyArray<unknown>) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
    if (!response.ok) throw new Error(`${method} failed`)
  }
  const client = createPublicClient({ transport })
  const wallet = createWalletClient({ account: deployer, transport })
  try {
    await ready(client)
    const deploy = async (name: keyof typeof artifacts, args: Hex = '0x') => {
      const hash = await wallet.sendTransaction({ data: `${code(name, 'bytecode')}${args.slice(2)}`, chain: null })
      const receipt = await client.waitForTransactionReceipt({ hash })
      if (receipt.contractAddress == null) throw new Error(`${name} did not deploy`)
      return receipt.contractAddress
    }
    const escrow = await deploy('escrow')
    const collector = await deploy('collector', `0x${word(escrow)}${word('0xca11')}`)
    const operator = await deploy('operator', `0x${word(escrow)}${word(collector)}${word('1f4')}${word(treasury)}`)
    await anvilCall('anvil_setCode', [usdc, code('token', 'deployedBytecode')])
    await installErc8004(anvilCall, async (initialize) =>
      client.waitForTransactionReceipt({ hash: await wallet.writeContract({ ...initialize, chain: null }) }),
    )
    const arbitrator = privateKeyToAccount(arbitratorKey).address
    const chain: SettlementChain = {
      ...arcTestnet({ operator, feeReceiver: treasury, arbitrator, confirmations: 1 }),
      escrow,
      collector,
      // The mock token: Solady's ERC20 with the name "USD Coin" and Solady's default version, "1".
      tokenDomain: { name: 'USD Coin', version: '1' },
    }
    return {
      url,
      client,
      chain,
      treasury,
      config: {
        chain,
        profile: chainProfiles['arc-testnet'],
        relayerKey: Redacted.make(relayerKey),
        arbitratorKey: Option.some(Redacted.make(arbitratorKey)),
        lowRelayerBalance: chainProfiles['arc-testnet'].lowRelayerBalance,
      },
      mint: async (to, amount) => {
        const hash = await wallet.writeContract({
          address: usdc,
          abi: tokenAbi,
          functionName: 'mint',
          args: [to, amount],
          chain: null,
        })
        await client.waitForTransactionReceipt({ hash })
      },
      balanceOf: (owner) =>
        client.readContract({ address: usdc, abi: tokenAbi, functionName: 'balanceOf', args: [owner] }),
      advance: async (seconds) => {
        await anvilCall('evm_increaseTime', [seconds])
        await anvilCall('evm_mine', [])
      },
      now: async () => Number((await client.getBlock()).timestamp),
      send: sendingOn(client, transport, anvilCall),
      stop: () => anvil.kill(),
    }
  } catch (cause) {
    anvil.kill()
    throw cause
  }
}
