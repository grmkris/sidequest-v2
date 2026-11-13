import * as Domain from '@alchemy.run/domain'
import { Sidequest } from '@sidequest/domain'
import type { Timing } from '@sidequest/domain/Job/SettlementPlan'
import { SettlementTiming } from '@sidequest/domain/Job/SettlementTiming'
import { Effect, Layer, Option, Schema } from 'effect'
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
import { DomainHandlers } from '../src/DomainLive.ts'
import { type IndexConfig, idleIndex, IndexSettings } from '../src/Index/IndexConfig.ts'
import { IndexLive } from '../src/Index/IndexLive.ts'
import { ClientDocuments } from '@sidequest/serving/ClientDocuments'
import type { EscrowConfig } from '../src/Settlement/EscrowConfig.ts'
import { escrowLive } from '../src/Settlement/SettlementLive.ts'
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

/** How a test world settles: no escrow (the default), or one on a test chain, with the sagas' timing. */
export interface Settling {
  readonly escrow: Option.Option<EscrowConfig>
  readonly timing?: Timing
}

/**
 * Client metadata documents for tests, by URL, in place of the hosts that publish them: a URL not in the map answers
 * nothing, as an unreachable host does. `fetched` records each URL asked for.
 */
export const clientDocuments = (documents: Readonly<Record<string, unknown>>) => {
  const fetched: Array<string> = []
  const layer = Layer.succeed(ClientDocuments, {
    fetch: (url) =>
      Effect.sync(() => {
        fetched.push(url)
        return Option.map(Option.fromNullishOr(documents[url]), (document) => JSON.stringify(document))
      }),
  })
  return { fetched, layer }
}

/**
 * Sign-in over the model in memory, its projections and the sign-in and settlement stores on a fresh local D1, and
 * `rpc` as the chain; the index on the same database, idle unless `index` names relays. `sqlite` reads the database
 * directly.
 */
export const signInWorld = (
  rpc: PublicClient,
  settling: Settling = { escrow: Option.none() },
  documents: Layer.Layer<ClientDocuments> = clientDocuments({}).layer,
  index: IndexConfig = idleIndex,
) => {
  const { sqlite, layer: sql } = localSql()
  const handlers =
    settling.timing === undefined
      ? DomainHandlers
      : DomainHandlers.pipe(Layer.provide(Layer.succeed(SettlementTiming, settling.timing)))
  const model = Sidequest.layer(handlers).pipe(Layer.provide(Domain.InMemory))
  const layer = Layer.mergeAll(
    SignInLive,
    documents,
    IndexLive.pipe(Layer.provide(Layer.succeed(IndexSettings, index))),
  ).pipe(
    Layer.provideMerge(model),
    Layer.provideMerge(escrowLive(settling.escrow)),
    Layer.provideMerge(Layer.succeed(ArcRpc, rpc)),
    Layer.provideMerge(sql),
  )
  return { sqlite, layer }
}

/** Sign `message` with a key, as a wallet would. */
export const signed = (signer: typeof ada, message: string): Effect.Effect<Hex> =>
  Effect.promise(() => signer.signMessage({ message }))
