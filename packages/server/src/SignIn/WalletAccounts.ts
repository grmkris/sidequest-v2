import { system } from '@sidequest/domain/Actor'
import { CurrentActor } from '@sidequest/domain/CurrentActor.context'
import { Account } from '@sidequest/domain/Identity/Account.aggregate'
import { ClaimWallet } from '@sidequest/domain/Identity/ClaimWallet.command'
import { RegisterAccount } from '@sidequest/domain/Identity/RegisterAccount.command'
import { ReserveWallet } from '@sidequest/domain/Identity/ReserveWallet.command'
import { WalletClaim } from '@sidequest/domain/Identity/WalletClaim.aggregate'
import { type AccountId, type AccountRef, generateId, Unavailable } from '@sidequest/protocol'
import { Context, Effect, Layer } from 'effect'

/** Sign-in acts as the system on wallet claims, once it has verified the wallet's signature. */
const signIn = system('sign-in')

/** The name an account starts with: its wallet's address, shortened. The person can rename it. */
const startingName = (wallet: AccountRef) => {
  const address = wallet.slice(wallet.lastIndexOf(':') + 1)
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

/**
 * The account a verified wallet signs in to. A wallet links to at most one account: the `WalletClaim` aggregate keyed
 * by the wallet holds that invariant. The first sign-in reserves the wallet for a new account id, registers the account
 * with the wallet, and claims the wallet for it. A later sign-in finds the wallet claimed and signs in to its account.
 * A sign-in that finds a reservation still held (a concurrent first sign-in, or one that stopped halfway) finishes it
 * for the account it reserved, so every sign-in with one wallet reaches one account.
 */
export class WalletAccounts extends Context.Service<
  WalletAccounts,
  { readonly accountFor: (wallet: AccountRef) => Effect.Effect<AccountId, Unavailable> }
>()('Sidequest/WalletAccounts') {
  static readonly layer = Layer.effect(
    WalletAccounts,
    Effect.gen(function* () {
      const accounts = yield* Account
      const claims = yield* WalletClaim
      const asSignIn = Effect.provideService(CurrentActor, signIn)

      /** Reserve the wallet for `proposed`; the account that holds it now, and whether it is claimed for good. */
      const reserve = (wallet: AccountRef, proposed: AccountId) =>
        claims.send(wallet, new ReserveWallet({ account: proposed })).pipe(
          Effect.as({ account: proposed, claimed: false }),
          Effect.catchTags({
            WalletTaken: ({ account }) => Effect.succeed({ account, claimed: true }),
            ReservationHeld: ({ account }) => Effect.succeed({ account, claimed: false }),
          }),
          asSignIn,
        )

      /** Register the account in its holder's name: sign-in proved the person controls the wallet. */
      const register = (account: AccountId, wallet: AccountRef) =>
        accounts.send(account, new RegisterAccount({ displayName: startingName(wallet), wallet })).pipe(
          Effect.catchTag('AlreadyRegistered', () => Effect.void),
          Effect.provideService(CurrentActor, { account }),
        )

      /** Commit the reservation; if it lapsed and another account claimed the wallet meanwhile, that account. */
      const claim = (wallet: AccountRef, account: AccountId) =>
        claims.send(wallet, new ClaimWallet({ account })).pipe(
          Effect.as(account),
          Effect.catchTags({
            WalletTaken: (taken) => Effect.succeed(taken.account),
            // Another sign-in took over the lapsed reservation and has not claimed it yet: try again shortly.
            NotReserved: () => Effect.fail(new Unavailable()),
          }),
          asSignIn,
        )

      return WalletAccounts.of({
        accountFor: Effect.fn('Sidequest.SignIn.accountFor')(
          function* (wallet) {
            const holder = yield* reserve(wallet, yield* generateId('AccountId'))
            if (holder.claimed) return holder.account
            yield* register(holder.account, wallet)
            return yield* claim(wallet, holder.account)
          },
          // The remaining rejections refuse a sender other than the system or the holder in person, which sign-in
          // never is.
          Effect.catchTags({
            SystemOnly: (rejection) => Effect.die(rejection),
            NotPermitted: (rejection) => Effect.die(rejection),
            PersonRequired: (rejection) => Effect.die(rejection),
            PartyRequired: (rejection) => Effect.die(rejection),
          }),
        ),
      })
    }),
  )
}
