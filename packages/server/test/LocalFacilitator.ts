import { readFileSync } from 'node:fs'
import { erc3009AuthorizationFields } from '@sidequest/protocol'
import { Option, Schema } from 'effect'
import {
  type Address,
  createWalletClient,
  type Hex,
  http,
  isAddress,
  isHex,
  parseAbi,
  type PublicClient,
  verifyTypedData,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

// An x402 facilitator for tests, in process: `/verify` and `/settle` of the `exact` scheme on EVM with ERC-3009
// (`specs/schemes/exact/scheme_exact_evm.md`, x402 v2), against a local chain. `/verify` checks the payload against the
// requirements, the signature against the token's EIP-712 domain, the window, the nonce and the balance, and simulates
// the transfer; `/settle` checks the same and submits `transferWithAuthorization` from its own key, paying the gas.
// It is a test double of a hosted facilitator (Circle's Facilitator Service, Coinbase's CDP), not one.

/** The test token: commerce-payments' ERC-3009 mock with `transferWithAuthorization` (contracts/test/mocks). */
const tokenArtifact = new URL(
  '../../../contracts/out/TransferAuthorizationToken.sol/TransferAuthorizationToken.json',
  import.meta.url,
)

/** The test token's runtime code, to place at the chain's USDC address. */
export const transferAuthorizationTokenCode = (): Hex => {
  const Artifact = Schema.fromJsonString(Schema.Struct({ deployedBytecode: Schema.Struct({ object: Schema.String }) }))
  const code = Schema.decodeUnknownSync(Artifact)(readFileSync(tokenArtifact, 'utf8')).deployedBytecode.object
  if (!isHex(code)) throw new Error('The test token has no runtime code: run `forge build` in contracts/')
  return code
}

const tokenAbi = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function transferAuthorizationState(address authorizer, bytes32 nonce) view returns (bool)',
  'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)',
])

const Authorization = Schema.Struct({
  from: Schema.String,
  to: Schema.String,
  value: Schema.String,
  validAfter: Schema.String,
  validBefore: Schema.String,
  nonce: Schema.String,
})
const Requirements = Schema.Struct({
  scheme: Schema.String,
  network: Schema.String,
  amount: Schema.String,
  asset: Schema.String,
  payTo: Schema.String,
  maxTimeoutSeconds: Schema.Int,
  extra: Schema.Struct({ name: Schema.String, version: Schema.String }),
})
const Call = Schema.Struct({
  x402Version: Schema.Literal(2),
  paymentPayload: Schema.Struct({
    x402Version: Schema.Literal(2),
    accepted: Requirements,
    payload: Schema.Struct({ signature: Schema.String, authorization: Authorization }),
  }),
  paymentRequirements: Requirements,
})
type Call = typeof Call.Type

const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase()

/** The first reason the call is invalid, in the specification's error codes, or the payer if it is valid. */
const check = async (client: PublicClient, call: Call): Promise<{ invalid: string } | { payer: Address }> => {
  const { accepted, payload } = call.paymentPayload
  const required = call.paymentRequirements
  const { authorization, signature } = payload
  const now = (await client.getBlock()).timestamp
  if (accepted.scheme !== 'exact' || required.scheme !== 'exact') return { invalid: 'unsupported_scheme' }
  if (accepted.network !== required.network || !same(accepted.asset, required.asset))
    return { invalid: 'invalid_network' }
  const chainId = Number(required.network.replace(/^eip155:/u, ''))
  if (chainId !== (await client.getChainId())) return { invalid: 'invalid_network' }
  if (!same(authorization.to, required.payTo)) return { invalid: 'invalid_exact_evm_payload_recipient_mismatch' }
  if (authorization.value !== required.amount)
    return { invalid: 'invalid_exact_evm_payload_authorization_value_mismatch' }
  if (BigInt(authorization.validAfter) >= now) return { invalid: 'invalid_exact_evm_payload_authorization_valid_after' }
  if (BigInt(authorization.validBefore) <= now)
    return { invalid: 'invalid_exact_evm_payload_authorization_valid_before' }
  const { from, to, nonce } = authorization
  if (!isAddress(from) || !isAddress(to) || !isHex(nonce) || !isHex(signature) || !isAddress(required.asset))
    return { invalid: 'invalid_payload' }
  const valid = await verifyTypedData({
    address: from,
    domain: { name: required.extra.name, version: required.extra.version, chainId, verifyingContract: required.asset },
    types: { TransferWithAuthorization: erc3009AuthorizationFields },
    primaryType: 'TransferWithAuthorization',
    message: {
      from,
      to,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce,
    },
    signature,
  })
  if (!valid) return { invalid: 'invalid_exact_evm_payload_signature' }
  const token = { address: required.asset, abi: tokenAbi } as const
  if (await client.readContract({ ...token, functionName: 'transferAuthorizationState', args: [from, nonce] }))
    return { invalid: 'invalid_transaction_state' }
  if ((await client.readContract({ ...token, functionName: 'balanceOf', args: [from] })) < BigInt(authorization.value))
    return { invalid: 'insufficient_funds' }
  return { payer: from }
}

const respond = (body: unknown) => Response.json(body)

/** Anvil's development key #3: the facilitator's, which pays settlement's gas. */
const facilitatorKey: Hex = '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6'

/** The facilitator over `client` and the chain at `url`: a fetch handler for its `/verify` and `/settle`. */
export const localFacilitator = (client: PublicClient, url: string) => {
  const account = privateKeyToAccount(facilitatorKey)
  const wallet = createWalletClient({ account, transport: http(url, { retryCount: 0 }) })
  const settled: Array<Hex> = []
  const settle = async (call: Call, payer: Address) => {
    const { authorization, signature } = call.paymentPayload.payload
    const network = call.paymentRequirements.network
    const { asset, payTo } = call.paymentRequirements
    if (!isAddress(asset) || !isAddress(payTo) || !isHex(authorization.nonce) || !isHex(signature))
      return respond({ success: false, errorReason: 'invalid_payload', transaction: '', network })
    const hash = await wallet.writeContract({
      address: asset,
      abi: tokenAbi,
      functionName: 'transferWithAuthorization',
      args: [
        payer,
        payTo,
        BigInt(authorization.value),
        BigInt(authorization.validAfter),
        BigInt(authorization.validBefore),
        authorization.nonce,
        signature,
      ],
      chain: null,
    })
    const receipt = await client.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success')
      return respond({ success: false, errorReason: 'invalid_transaction_state', transaction: hash, network, payer })
    settled.push(hash)
    return respond({ success: true, transaction: hash, network, payer })
  }
  const fetch = async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname
    const call = Schema.decodeUnknownOption(Call)(await request.json())
    if (Option.isNone(call)) return respond({ isValid: false, invalidReason: 'invalid_payload' })
    const checked = await check(client, call.value)
    if (path === '/verify')
      return respond(
        'invalid' in checked
          ? { isValid: false, invalidReason: checked.invalid }
          : { isValid: true, payer: checked.payer },
      )
    if (path !== '/settle') return new Response(null, { status: 404 })
    if ('invalid' in checked)
      return respond({
        success: false,
        errorReason: checked.invalid,
        transaction: '',
        network: call.value.paymentRequirements.network,
      })
    return settle(call.value, checked.payer)
  }
  return { fetch, settled, address: account.address }
}
