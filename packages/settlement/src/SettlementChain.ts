import { type AssetRef, UsdcOnArcTestnet } from '@sidequest/protocol'
import { type Address, getAddress } from 'viem'

/**
 * Everything settlement needs to know about the one chain a job settles on: the escrow contracts, the token, the
 * operator and its immutable fee terms, the interim arbitrator, and how many confirmations make an event count.
 */
export interface SettlementChain {
  /** CAIP-2 network and its EIP-155 chain id. */
  readonly chainId: number
  /** The asset jobs on this chain are paid in. */
  readonly asset: AssetRef
  /** The asset's ERC-20 (and ERC-3009) contract. */
  readonly token: Address
  /** The token's EIP-712 domain name and version, which its `ReceiveWithAuthorization` signatures use. */
  readonly tokenDomain: { readonly name: string; readonly version: string }
  /** Coinbase's `AuthCaptureEscrow` v1.1. */
  readonly escrow: Address
  /** The escrow's `ERC3009PaymentCollector`. */
  readonly collector: Address
  /** The deployed `SidequestOperator`. */
  readonly operator: Address
  /** The operator's immutable `FEE_BPS`. */
  readonly feeBps: number
  /** The operator's immutable `FEE_RECEIVER`: the treasury. */
  readonly feeReceiver: Address
  /** The interim arbitrator every job names (for now a Sidequest-held testnet key). */
  readonly arbitrator: Address
  /** Blocks on top of an event's block before the reader reports it. 1 means the event's own block suffices. */
  readonly confirmations: number
}

/** `SidequestOperator.MARGIN`: slack between the last job window and the escrow's `authorizationExpiry`. */
export const operatorMargin = 24 * 60 * 60

/** Arc testnet's deployed escrow and collector (`contracts/README.md`, checked by the fork test). */
export const arcTestnetEscrow = getAddress('0xf96815976523E00e65Be8f34cA5e64b4f41EB19c')
export const arcTestnetCollector = getAddress('0x8612dfdc421f80336cd14E8EF9cb1E765dB5ab88')

/**
 * Arc testnet USDC's EIP-712 domain. Verified on 2026-11-12 against https://rpc.testnet.arc.io: `name()` is "USDC",
 * `version()` is "2", and `DOMAIN_SEPARATOR()` is
 * 0x361191522483d32a83e70ae7183b4b9629442c13a78bc9921d6f707911c8c6b0, which equals
 * keccak256(abi.encode(keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
 * keccak256("USDC"), keccak256("2"), 5042002, 0x3600…0000)) recomputed locally; its
 * `RECEIVE_WITH_AUTHORIZATION_TYPEHASH()` is the ERC-3009 one. Its `eip712Domain()` (EIP-5267) reverts.
 */
export const arcTestnetUsdcDomain = { name: 'USDC', version: '2' } as const

/** What a deployment configures: the operator is not deployed yet, so its address and the treasury come from here. */
export interface ArcTestnetDeployment {
  readonly operator: string
  readonly feeReceiver: string
  readonly arbitrator: string
  readonly feeBps?: number
  readonly confirmations?: number
}

const tokenOf = (asset: AssetRef) => getAddress(asset.id.slice(asset.id.lastIndexOf(':') + 1))

/** Arc testnet, with the deployment's operator, treasury and arbitrator. */
export const arcTestnet = (deployment: ArcTestnetDeployment): SettlementChain => ({
  chainId: 5042002,
  asset: UsdcOnArcTestnet,
  token: tokenOf(UsdcOnArcTestnet),
  tokenDomain: arcTestnetUsdcDomain,
  escrow: arcTestnetEscrow,
  collector: arcTestnetCollector,
  operator: getAddress(deployment.operator),
  feeBps: deployment.feeBps ?? 500,
  feeReceiver: getAddress(deployment.feeReceiver),
  arbitrator: getAddress(deployment.arbitrator),
  confirmations: deployment.confirmations ?? 3,
})
