import { ModerationRefused, SidequestApi, type SettlementHealth, Unavailable } from '@sidequest/protocol'
import { Clock, Effect, Option } from 'effect'
import * as HttpEffect from 'effect/http/HttpEffect'
import { HttpServerRequest } from 'effect/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'
import { HttpApiBuilder } from 'effect/http-api'
import { requireNip98Key } from '../Escrow/Arbitration.ts'
import { type EscrowChain, escrowChain } from '../Escrow/EscrowChain.ts'
import { gasCommitted, type LaunchCaps, LaunchCapSettings, utcDayStart } from '../Escrow/LaunchCaps.ts'
import { hiddenNow, Moderation, ModerationSettings } from '../Index/Moderation.ts'

const unconfigured: SettlementHealth = {
  configured: false,
  chainId: null,
  mainnet: null,
  relayer: null,
  balance: null,
  low: null,
  threshold: null,
  gasCommittedToday: null,
  dailyGasBudget: null,
}

/** Never cached: a balance read a minute ago may already be the one that ran out. */
const uncached = HttpEffect.appendPreResponseHandler((_, response) =>
  Effect.succeed(HttpServerResponse.setHeader(response, 'cache-control', 'no-store')),
)

const healthOf = Effect.fnUntraced(function* (
  on: EscrowChain,
  caps: LaunchCaps,
  committedSince: (signer: string, since: number) => Effect.Effect<bigint, Unavailable>,
) {
  const balance = yield* on.relayerBalance.pipe(Effect.mapError(() => new Unavailable()))
  const committed = Option.isSome(caps.dailyGasWei)
    ? String(yield* committedSince(on.relayer, utcDayStart(yield* Clock.currentTimeMillis)))
    : null
  const health: SettlementHealth = {
    configured: true,
    chainId: on.chain.chainId,
    mainnet: on.mainnet,
    relayer: on.relayer,
    balance: String(balance),
    low: balance < on.lowRelayerBalance,
    threshold: String(on.lowRelayerBalance),
    gasCommittedToday: committed,
    dailyGasBudget: Option.getOrNull(Option.map(caps.dailyGasWei, String)),
  }
  return health
})

/**
 * The `operations` group: the relayer's health, read from the chain, and the index's hide list, which anyone reads and
 * only the stage's moderator key (`SIDEQUEST_MODERATOR_PUBKEY`, by NIP-98 for exactly the request) changes.
 */
export const operationsHandlers = HttpApiBuilder.group(SidequestApi, 'operations', (handlers) =>
  Effect.gen(function* () {
    const chain = yield* escrowChain
    const caps = yield* LaunchCapSettings
    const committed = yield* gasCommitted
    const moderation = yield* Moderation
    const settings = yield* ModerationSettings
    const moderator = Effect.flatMap(HttpServerRequest, (request) =>
      requireNip98Key(request, settings.moderatorPubkey, (reason) => new ModerationRefused({ reason })),
    )
    return handlers
      .handle('settlementHealth', () =>
        Effect.andThen(
          uncached,
          Option.match(chain, {
            onNone: () => Effect.succeed(unconfigured),
            onSome: (on) => healthOf(on, caps, committed),
          }),
        ),
      )
      .handle('hidden', () => Effect.map(Effect.andThen(uncached, moderation.list), (items) => ({ items: [...items] })))
      .handle('hide', ({ params, payload }) =>
        Effect.gen(function* () {
          const by = yield* moderator
          return yield* moderation.hide(yield* hiddenNow(params.target, payload, by))
        }),
      )
      .handle('unhide', ({ params }) =>
        Effect.gen(function* () {
          yield* moderator
          yield* moderation.unhide(params.target)
          return { target: params.target }
        }),
      )
  }),
)
