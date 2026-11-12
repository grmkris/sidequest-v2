import { Layer } from 'effect'
import { AgentAccess } from '../Agents/AgentAccess.ts'
import { AgentTokens } from '../Agents/AgentTokens.ts'
import { Nonces } from './Nonces.ts'
import { SessionLive } from './SessionMiddleware.ts'
import { Sessions } from './Sessions.ts'
import { SignIn } from './SignIn.ts'
import { WalletAccounts } from './WalletAccounts.ts'

/** Agents' access tokens in D1, and who they let in, from the `Agent` aggregate. */
const AgentAccessLive = AgentAccess.layer.pipe(Layer.provideMerge(AgentTokens.layer))

/**
 * Wallet sign-in, agents' access tokens and the domain's `Session` middleware, with the D1 stores they keep nonces,
 * sessions and tokens in. Needs the hosted model (`Account`, `WalletClaim`, `Agent`), the database's `SqlClient` and
 * an `ArcRpc` client.
 */
export const SignInLive = Layer.mergeAll(SignIn.layer, SessionLive).pipe(
  Layer.provideMerge(Layer.mergeAll(WalletAccounts.layer, Nonces.layer, Sessions.layer, AgentAccessLive)),
)
