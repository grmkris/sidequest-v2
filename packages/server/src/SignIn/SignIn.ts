import { unixSeconds } from '@sidequest/domain/Authority'
import { type SessionView, type SignInChallenge, SignInRefused, type Unavailable } from '@sidequest/protocol'
import { Context, DateTime, Effect, Layer, type Redacted } from 'effect'
import { getAddress, type Hex } from 'viem'
import { ArcRpc } from './ArcRpc.ts'
import { Nonces } from './Nonces.ts'
import { randomHex, Sessions } from './Sessions.ts'
import { challengeMessage, challengeSeconds, checkMessage, type Site, walletRef } from './Siwe.ts'
import { WalletAccounts } from './WalletAccounts.ts'
import { signatureCheck } from './WalletSignature.ts'

const now = Effect.map(DateTime.now, unixSeconds)

/**
 * Signing in with a wallet. `challenge` issues a nonce for the wallet and the site and writes the SIWE message to
 * sign. `verify` checks a signed message: its fields (site, chain, time), then the signature, then consumes its nonce
 * (once, for the wallet and site it was issued to), and opens a session for the account the wallet signs in to.
 */
export class SignIn extends Context.Service<
  SignIn,
  {
    readonly challenge: (site: Site, address: string) => Effect.Effect<SignInChallenge, Unavailable>
    readonly verify: (
      site: Site,
      message: string,
      signature: Hex,
    ) => Effect.Effect<
      { readonly token: Redacted.Redacted; readonly session: SessionView },
      SignInRefused | Unavailable
    >
  }
>()('Sidequest/SignIn') {
  static readonly layer = Layer.effect(
    SignIn,
    Effect.gen(function* () {
      const nonces = yield* Nonces
      const sessions = yield* Sessions
      const wallets = yield* WalletAccounts
      const signedBy = signatureCheck(yield* ArcRpc)
      return SignIn.of({
        challenge: Effect.fn('Sidequest.SignIn.challenge')(function* (site, address) {
          const issuedAt = yield* now
          const nonce = yield* randomHex(16)
          const wallet = getAddress(address)
          const expiresAt = issuedAt + challengeSeconds
          yield* nonces.issue({ nonce, address: wallet, domain: site.domain, issuedAt, expiresAt })
          return { message: yield* challengeMessage({ site, address: wallet, nonce, issuedAt }), expiresAt }
        }),
        verify: Effect.fn('Sidequest.SignIn.verify')(function* (site, message, signature) {
          const at = yield* now
          const { address, nonce } = yield* checkMessage(message, site, at)
          if (!(yield* signedBy(address, message, signature)))
            return yield* new SignInRefused({ reason: 'bad_signature' })
          if (!(yield* nonces.consume({ nonce, address, domain: site.domain }, at)))
            return yield* new SignInRefused({ reason: 'unknown_nonce' })
          const wallet = walletRef(address)
          return yield* sessions.open(yield* wallets.accountFor(wallet), wallet, at)
        }),
      })
    }),
  )
}
