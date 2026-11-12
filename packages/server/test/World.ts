import * as Domain from '@alchemy.run/domain'
import { Sidequest, SidequestHandlers } from '@sidequest/domain'
import { Effect, Layer, Schema } from 'effect'
import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeFunctionResult,
  type Hex,
  isAddress,
  isAddressEqual,
  isHex,
  parseAbi,
  type PublicClient,
  recoverAddress,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { D1Stores } from '../src/DomainLive.ts'
import { ArcRpc } from '../src/SignIn/ArcRpc.ts'
import { SignInLive } from '../src/SignIn/SignInLive.ts'
import { siteOf } from '../src/SignIn/Siwe.ts'
import { localSql } from './LocalSql.ts'

/** The site the tests sign in to. */
export const site = siteOf(new URL('https://sidequest.test'))

/** Two people's keys, fixed so failures reproduce. */
export const ada = privateKeyToAccount('0x1111111111111111111111111111111111111111111111111111111111111111')
export const ben = privateKeyToAccount('0x2222222222222222222222222222222222222222222222222222222222222222')

/** A contract account (a smart wallet) at a fixed address, which accepts what its owner, Ben's key, signs. */
export const smartWallet = { address: '0x5a1e5a1e5a1e5a1e5a1e5a1e5a1e5a1e5a1e5a1e', owner: ben.address } as const

const erc1271 = parseAbi(['function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)'])

const Call = Schema.Struct({
  method: Schema.String,
  params: Schema.optional(Schema.Array(Schema.Unknown)),
})
const CallParams = Schema.Struct({ to: Schema.String, data: Schema.String })

/** What the fake chain was asked, by method. */
export interface Asked {
  readonly methods: Array<string>
}

/**
 * Arc testnet for tests, answering `eth_call` only: {@link smartWallet} runs ERC-1271 and accepts a signature its owner
 * key made of the hash, and reverts otherwise; every other address has no code. Anything else it is asked fails.
 */
export const fakeArc = (): { readonly client: PublicClient; readonly asked: Asked } => {
  const asked: Asked = { methods: [] }
  const request = async (input: unknown) => {
    const { method, params = [] } = Schema.decodeUnknownSync(Call)(input)
    asked.methods.push(method)
    if (method !== 'eth_call') throw new Error(`The fake chain does not answer ${method}`)
    const { to, data } = Schema.decodeUnknownSync(CallParams)(params[0])
    if (!isAddress(to) || !isAddressEqual(to, smartWallet.address)) return '0x'
    if (!isHex(data)) throw new Error('Calldata is not hex')
    const { args } = decodeFunctionData({ abi: erc1271, data })
    const [hash, signature] = args
    if (!isAddressEqual(await recoverAddress({ hash, signature }), smartWallet.owner))
      throw new Error('execution reverted')
    return encodeFunctionResult({ abi: erc1271, functionName: 'isValidSignature', result: '0x1626ba7e' })
  }
  return { client: createPublicClient({ transport: custom({ request }) }), asked }
}

/**
 * Sign-in over the model in memory, its projections and the sign-in stores on a fresh local D1, and `rpc` as the
 * chain. `sqlite` reads the database directly.
 */
export const signInWorld = (rpc: PublicClient) => {
  const { sqlite, layer: sql } = localSql()
  const model = Sidequest.layer(SidequestHandlers.pipe(Layer.provide(D1Stores))).pipe(Layer.provide(Domain.InMemory))
  const layer = SignInLive.pipe(
    Layer.provide(Layer.succeed(ArcRpc, rpc)),
    Layer.provideMerge(model),
    Layer.provideMerge(sql),
  )
  return { sqlite, layer }
}

/** Sign `message` with a key, as a wallet would. */
export const signed = (signer: typeof ada, message: string): Effect.Effect<Hex> =>
  Effect.promise(() => signer.signMessage({ message }))
