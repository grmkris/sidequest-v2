import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import type { AccountId } from '@sidequest/protocol'
import { arcTestnet, type SettlementChain } from '@sidequest/settlement/SettlementChain'
import { Option, Redacted, Schema } from 'effect'
import {
  type Address,
  createPublicClient,
  createWalletClient,
  type Hex,
  http,
  isHex,
  parseAbi,
  type PublicClient,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { EscrowConfig } from '../src/Settlement/EscrowConfig.ts'

// A local chain for the settlement journey: Anvil with Arc testnet's chain id, the real `AuthCaptureEscrow` v1.1, its
// `ERC3009PaymentCollector` and `SidequestOperator` from the Foundry build, and commerce-payments' ERC-3009 mock token
// placed at Arc's USDC address. Available only where `anvil` runs and `contracts/out` holds the build
// (`forge soldeer install && forge build` in `contracts/`); the journey skips itself otherwise.

const out = new URL('../../../contracts/out/', import.meta.url)
const artifacts = {
  escrow: 'AuthCaptureEscrow.sol/AuthCaptureEscrow.json',
  collector: 'ERC3009PaymentCollector.sol/ERC3009PaymentCollector.json',
  token: 'MockERC3009Token.sol/MockERC3009Token.json',
  operator: 'SidequestOperator.sol/SidequestOperator.json',
} as const

/** Whether the journey can run here: Anvil installed and the contracts built. */
export const anvilAvailable =
  spawnSync('anvil', ['--version'], { stdio: 'ignore' }).status === 0 &&
  Object.values(artifacts).every((file) => existsSync(new URL(file, out)))

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

const tokenAbi = parseAbi([
  'function mint(address to, uint256 amount)',
  'function balanceOf(address owner) view returns (uint256)',
])

export interface LocalChain {
  readonly client: PublicClient
  /** Settlement on this chain, every confirmation counting at once. */
  readonly config: (arbitrationOperator: Option.Option<AccountId>) => EscrowConfig
  readonly chain: SettlementChain
  readonly treasury: Address
  readonly mint: (to: Address, amount: bigint) => Promise<void>
  readonly balanceOf: (owner: Address) => Promise<bigint>
  /** Move the chain's clock forward and mine a block. */
  readonly advance: (seconds: number) => Promise<void>
  readonly now: () => Promise<number>
  readonly stop: () => void
}

/** Start Anvil and deploy the escrow, the collector, the operator and the token. */
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
    const arbitrator = privateKeyToAccount(arbitratorKey).address
    const chain: SettlementChain = {
      ...arcTestnet({ operator, feeReceiver: treasury, arbitrator, confirmations: 1 }),
      escrow,
      collector,
      // The mock token: Solady's ERC20 with the name "USD Coin" and Solady's default version, "1".
      tokenDomain: { name: 'USD Coin', version: '1' },
    }
    return {
      client,
      chain,
      treasury,
      config: (arbitrationOperator) => ({
        chain,
        relayerKey: Redacted.make(relayerKey),
        arbitratorKey: Option.some(Redacted.make(arbitratorKey)),
        arbitrationOperator,
      }),
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
      stop: () => anvil.kill(),
    }
  } catch (cause) {
    anvil.kill()
    throw cause
  }
}
