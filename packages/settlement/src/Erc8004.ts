import { Effect, Option } from 'effect'
import {
  type Address,
  BaseError,
  ContractFunctionRevertedError,
  encodeFunctionData,
  getAddress,
  type Hex,
  type PublicClient,
  zeroAddress,
} from 'viem'
import { erc8004IdentityAbi, erc8004ReputationAbi } from './abi/Erc8004.ts'
import type { ChainName, ChainProfile } from './Chains.ts'
import { ChainUnavailable } from './ChainRpc.ts'

/** A chain's ERC-8004 registries: the identity registry tokens are minted on, and the reputation registry beside it. */
export interface Erc8004Registries {
  readonly chainId: number
  readonly identity: Address
  readonly reputation: Address
}

// The reference implementation's CREATE2 addresses, one set on testnets and one on mainnets (erc-8004/erc-8004-contracts
// b9e466c, `scripts/addresses.ts`), each read on chain on 2026-11-13 (`getVersion()` = 2.0.0; docs/adr/0007).
const testnetSet = {
  identity: getAddress('0x8004A818BFB912233c491871b3d84c89A494BD9e'),
  reputation: getAddress('0x8004B663056A597Dffe9eCcC1965A193B7388713'),
}
const mainnetSet = {
  identity: getAddress('0x8004A169FB4a3325136EB29fA0ceB6D2e539a432'),
  reputation: getAddress('0x8004BAa17C55a88189AE136b182e5fdA19dE9b63'),
}

/**
 * The registries on each chain a stage can settle on (`Chains.ts`), keyed as its profiles are. Every one has them;
 * Arc mainnet's are in Circle's contract-address page, not yet in the reference repository's list.
 */
export const erc8004Deployments: Readonly<Record<ChainName, typeof testnetSet>> = {
  'arc-testnet': testnetSet,
  'arc-mainnet': mainnetSet,
  'base-mainnet': mainnetSet,
}

/**
 * The registries on a stage's chain. A stage reaches a mainnet profile only once its mainnet opt-in passed
 * (`chainRefusal`), so a mainnet registry is only ever used where real money may move.
 */
export const erc8004RegistriesOf = (profile: ChainProfile): Erc8004Registries => ({
  chainId: profile.chainId,
  ...erc8004Deployments[profile.name],
})

/** What the identity registry says of a token at one block: its owner (`None`: no such token) and its `agentURI`. */
export interface TokenRead {
  readonly owner: Option.Option<Address>
  readonly agentUri: string
}

const reverted = (cause: unknown) =>
  cause instanceof BaseError && cause.walk((error) => error instanceof ContractFunctionRevertedError) !== null

const reasonOf = (cause: unknown) =>
  (cause instanceof BaseError ? cause.shortMessage : cause instanceof Error ? cause.message : String(cause)).slice(
    0,
    200,
  )

/**
 * A token's owner and `agentURI` at `blockNumber`. `ownerOf` reverting is the registry saying there is no such token
 * (ERC-721 reverts for one never minted or burned): that is an answer, not the chain being unavailable. Any other
 * failure is.
 */
const call = <A>(operation: string, read: () => Promise<A>) =>
  Effect.tryPromise({ try: read, catch: (cause) => ({ cause, operation }) })
const unavailable = ({ cause, operation }: { readonly cause: unknown; readonly operation: string }) =>
  new ChainUnavailable({ operation, reason: reasonOf(cause) })

export const readToken = Effect.fnUntraced(function* (
  rpc: PublicClient,
  identity: Address,
  agentId: bigint,
  blockNumber: bigint,
) {
  const owner = yield* call('ownerOf', () =>
    rpc.readContract({
      address: identity,
      abi: erc8004IdentityAbi,
      functionName: 'ownerOf',
      args: [agentId],
      blockNumber,
    }),
  ).pipe(
    Effect.map((address) => (address === zeroAddress ? Option.none<Address>() : Option.some(getAddress(address)))),
    Effect.catch((failure) =>
      reverted(failure.cause) ? Effect.succeed(Option.none<Address>()) : Effect.fail(unavailable(failure)),
    ),
  )
  if (Option.isNone(owner)) return { owner, agentUri: '' } satisfies TokenRead
  const agentUri = yield* call('tokenURI', () =>
    rpc.readContract({
      address: identity,
      abi: erc8004IdentityAbi,
      functionName: 'tokenURI',
      args: [agentId],
      blockNumber,
    }),
  ).pipe(Effect.mapError(unavailable))
  return { owner, agentUri } satisfies TokenRead
})

/** The calldata of `register(agentURI)`: the token is minted to whoever sends it. */
export const registerCalldata = (agentUri: string): Hex =>
  encodeFunctionData({ abi: erc8004IdentityAbi, functionName: 'register', args: [agentUri] })

/** One piece of feedback as `giveFeedback` takes it. */
export interface FeedbackArguments {
  readonly agentId: bigint
  readonly value: bigint
  readonly valueDecimals: number
  readonly tag1: string
  readonly tag2: string
  readonly endpoint: string
  readonly feedbackUri: string
  readonly feedbackHash: Hex
}

/** The calldata of `giveFeedback`: the client is whoever sends it, and must not own or operate the agent. */
export const giveFeedbackCalldata = (feedback: FeedbackArguments): Hex =>
  encodeFunctionData({
    abi: erc8004ReputationAbi,
    functionName: 'giveFeedback',
    args: [
      feedback.agentId,
      feedback.value,
      feedback.valueDecimals,
      feedback.tag1,
      feedback.tag2,
      feedback.endpoint,
      feedback.feedbackUri,
      feedback.feedbackHash,
    ],
  })
