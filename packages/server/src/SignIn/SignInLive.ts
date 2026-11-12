import { Layer } from 'effect'
import { Nonces } from './Nonces.ts'
import { SessionLive } from './SessionMiddleware.ts'
import { Sessions } from './Sessions.ts'
import { SignIn } from './SignIn.ts'
import { WalletAccounts } from './WalletAccounts.ts'

/**
 * Wallet sign-in and the domain's `Session` middleware, with the D1 stores they keep nonces and sessions in. Needs the
 * hosted model (`Account`, `WalletClaim`), the database's `SqlClient` and an `ArcRpc` client.
 */
export const SignInLive = Layer.mergeAll(SignIn.layer, SessionLive).pipe(
  Layer.provideMerge(Layer.mergeAll(WalletAccounts.layer, Nonces.layer, Sessions.layer)),
)
