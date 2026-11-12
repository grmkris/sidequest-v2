import * as Domain from '@alchemy.run/domain'
import { AccountId, AccountRef, UnixSeconds } from '@sidequest/protocol'
import { Effect, Match, Schema } from 'effect'
import { asSystem, unixSeconds } from '../Authority.ts'
import { ClaimWallet, NotReserved, WalletClaimed } from './ClaimWallet.command.ts'
import { ReservationHeld, ReserveWallet, WalletReserved } from './ReserveWallet.command.ts'
import { WalletTaken } from './WalletTaken.rejection.ts'

/** How long a reservation holds the wallet for the account being registered with it. */
export const reservationSeconds = 300

const WalletClaimState = Schema.Union([
  Schema.TaggedStruct('Unclaimed', {}),
  Schema.TaggedStruct('Reserved', { account: AccountId, until: UnixSeconds }),
  Schema.TaggedStruct('Claimed', { account: AccountId }),
])

/**
 * One wallet (a CAIP-10 account) and the one Sidequest account it belongs to. Accounts are aggregates of their own,
 * so no account can see another's wallets: this aggregate, keyed by the wallet, is the invariant that a wallet links
 * to at most one account. Sign-in reserves the wallet for the account it is about to register, then claims it once
 * the account is registered; a reservation that lapsed may be taken by another account.
 */
export class WalletClaim extends Domain.Aggregate('WalletClaim', {
  id: AccountRef,
  state: WalletClaimState,
  initial: { _tag: 'Unclaimed' },
  commands: [ReserveWallet, ClaimWallet],
  decide: {
    ReserveWallet: Effect.fn(function* (state, { account }, { now }) {
      yield* asSystem()
      const at = unixSeconds(now)
      const reserve = [new WalletReserved({ account, until: at + reservationSeconds })]
      return yield* Match.valueTags(state, {
        Unclaimed: () => Effect.succeed(reserve),
        Reserved: (held) => {
          if (held.until <= at) return Effect.succeed(reserve)
          if (held.account === account) return Effect.succeed([])
          return Effect.fail(new ReservationHeld({ account: held.account, until: held.until }))
        },
        Claimed: (claimed) =>
          claimed.account === account ? Effect.succeed([]) : Effect.fail(new WalletTaken({ account: claimed.account })),
      })
    }),
    ClaimWallet: Effect.fn(function* (state, { account }) {
      yield* asSystem()
      return yield* Match.valueTags(state, {
        Unclaimed: () => Effect.fail(new NotReserved({ account })),
        Reserved: (held) =>
          held.account === account
            ? Effect.succeed([new WalletClaimed({ account })])
            : Effect.fail(new NotReserved({ account })),
        Claimed: (claimed) =>
          claimed.account === account ? Effect.succeed([]) : Effect.fail(new WalletTaken({ account: claimed.account })),
      })
    }),
  },
  evolve: {
    WalletReserved: (_, { account, until }) => ({ _tag: 'Reserved' as const, account, until }),
    WalletClaimed: (_, { account }) => ({ _tag: 'Claimed' as const, account }),
  },
}) {}
