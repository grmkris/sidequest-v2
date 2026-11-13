import type { Unavailable } from '@sidequest/protocol'
import { type ChainUnavailable, rpcCall } from '@sidequest/settlement/ChainRpc'
import { type Erc8004Registries, erc8004RegistriesOn, readToken } from '@sidequest/settlement/Erc8004'
import { Context, Effect, Layer, Option } from 'effect'
import { nowSeconds } from '../Index/Ingest.ts'
import { ArcRpc } from '../Settlement/ArcRpc.ts'
import { Settlement } from '../Settlement/Settlement.ts'
import { Erc8004Identities } from './Identities.ts'

/**
 * How the reader goes: at most `tokensPerRun` tokens a run, each read again once its last read is `rereadSeconds` old,
 * so a transfer or a new `agentURI` shows within ten minutes and a claim just published within a minute.
 */
export const erc8004ReadLimits = { tokensPerRun: 20, rereadSeconds: 600 } as const

/** The stage's ERC-8004 registries and the confirmations a read waits for: those of its settlement chain, if any. */
export interface Erc8004Stage {
  readonly registries: Erc8004Registries
  readonly confirmations: number
  /** The identity registry as claims name it: CAIP-10, in lowercase. */
  readonly identity: string
}

/** The registries on the settlement chain the stage is configured with; none without settlement. */
export const erc8004StageOf = (settlement: Settlement['Service']): Option.Option<Erc8004Stage> =>
  Option.flatMap(settlement, ({ chain }) =>
    Option.map(erc8004RegistriesOn(chain.chainId), (registries) => ({
      registries,
      confirmations: chain.confirmations,
      identity: `eip155:${chain.chainId}:${registries.identity.toLowerCase()}`,
    })),
  )

/**
 * Reads claimed tokens on the stage's identity registry into `erc8004_tokens`: never-read ones first, then the
 * stalest, each at the confirmed head (`confirmations` deep), through the settlement chain's RPC. A claim naming
 * another registry is never read here, and stays `unchecked`.
 */
export class Erc8004Reader extends Context.Service<
  Erc8004Reader,
  { readonly run: Effect.Effect<void, ChainUnavailable | Unavailable> }
>()('Sidequest/Erc8004/Reader') {
  /** Over `Settlement`, `ArcRpc` and the `Erc8004Identities`; idle on a stage without a settlement chain. */
  static readonly layer = Layer.effect(
    Erc8004Reader,
    Effect.gen(function* () {
      const stage = erc8004StageOf(yield* Settlement)
      const rpc = yield* ArcRpc
      const identities = yield* Erc8004Identities
      const run = Effect.gen(function* () {
        if (Option.isNone(stage)) return
        const { registries, confirmations, identity } = stage.value
        const now = yield* nowSeconds
        const due = yield* identities.due(
          identity,
          now - erc8004ReadLimits.rereadSeconds,
          erc8004ReadLimits.tokensPerRun,
        )
        if (due.length === 0) return
        const head = yield* rpcCall('eth_blockNumber', () => rpc.getBlockNumber({ cacheTime: 0 }))
        const block = head - BigInt(Math.max(confirmations, 1) - 1)
        if (block < 0n) return
        yield* Effect.forEach(
          due,
          (token) =>
            Effect.gen(function* () {
              const read = yield* readToken(rpc, registries.identity, BigInt(token.agentId), block)
              yield* identities.record(
                {
                  ...token,
                  owner: Option.getOrNull(Option.map(read.owner, (owner) => owner.toLowerCase())),
                  agentUri: read.agentUri,
                  block: Number(block),
                },
                now,
              )
            }),
          { discard: true },
        )
      }).pipe(Effect.withSpan('Sidequest.Erc8004.read'))
      return Erc8004Reader.of({ run })
    }),
  )
}
