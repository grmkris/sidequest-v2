import { Effect } from 'effect'
import { failedWith, type Problem } from './Problem.ts'
import { type Connection, Wallet } from './Wallet.ts'

/** Asks the wallet for its account, answering a page's Message for the connection or for the problem. */
export const connectWallet = <Succeeded, Failed>(
  succeeded: (connection: Connection) => Succeeded,
  failed: (payload: { readonly problem: Problem }) => Failed,
): Effect.Effect<Succeeded | Failed, never, Wallet> =>
  Wallet.use((wallet) => wallet.connect).pipe(
    Effect.map((connection): Succeeded | Failed => succeeded(connection)),
    Effect.catch(failedWith<Succeeded | Failed>(failed)),
  )
