import { createHash } from 'node:crypto'
import * as Domain from '@alchemy.run/domain'
import { it } from '@effect/vitest'
import { Account } from '@sidequest/domain/Identity/Account.aggregate'
import { RenameAccount } from '@sidequest/domain/Identity/RenameAccount.command'
import { WalletClaim } from '@sidequest/domain/Identity/WalletClaim.aggregate'
import { AccountRef, sessionCookieName, SignInRefused, Unavailable } from '@sidequest/protocol'
import { DateTime, Effect, Option, Redacted, Result, Schema } from 'effect'
import { TestClock } from 'effect/testing'
import { createPublicClient, getAddress, http, type PublicClient } from 'viem'
import { createSiweMessage } from 'viem/siwe'
import { describe, expect } from 'vitest'
import { Sessions } from '../src/SignIn/Sessions.ts'
import { SignIn } from '../src/SignIn/SignIn.ts'
import { siteOf } from '../src/SignIn/Siwe.ts'
import { ada, ben, fakeArc, signed, signInWorld, site, smartWallet } from './World.ts'

// Sign-in as a whole, over the model in memory, a local D1 and a fake chain: challenge, signature, nonce, account and
// session. The time is 2026-11-12T10:00:00Z.
const start = Date.parse('2026-11-12T10:00:00Z')

type Signer = typeof ada

/** Ask for a challenge for `address` and have `signer` sign it. */
const challenged = (signer: Signer, address: string = signer.address) =>
  Effect.gen(function* () {
    const { message } = yield* (yield* SignIn).challenge(site, address)
    return { message, signature: yield* signed(signer, message) }
  })

const verified = ({ message, signature }: { readonly message: string; readonly signature: `0x${string}` }) =>
  Effect.flatMap(SignIn, (signIn) => signIn.verify(site, message, signature))

const signInAs = (signer: Signer, address?: string) => Effect.flatMap(challenged(signer, address), verified)

const refusalOf = <A, R>(effect: Effect.Effect<A, SignInRefused | Unavailable, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => (error instanceof SignInRefused ? error.reason : 'unavailable')),
  )

const wallet = (address: string) => AccountRef.make(`eip155:5042002:${getAddress(address)}`)

/** Run `test` at the start time, in a fresh world whose chain is `rpc`. */
const inWorld = <A, E, R>(test: Effect.Effect<A, E, R>, rpc: PublicClient = fakeArc().client) =>
  Effect.andThen(TestClock.setTime(start), test).pipe(Effect.provide(signInWorld(rpc).layer))

describe('wallet sign-in', () => {
  it.effect('signs a key in to a new account with its wallet, then to the same account, never asking the chain', () => {
    const chain = fakeArc()
    return inWorld(
      Effect.gen(function* () {
        const first = yield* signInAs(ada)
        const again = yield* signInAs(ada)
        const other = yield* signInAs(ben)
        expect(first.session.wallet).toBe(wallet(ada.address))
        expect(again.session.account).toBe(first.session.account)
        expect(other.session.account).not.toBe(first.session.account)
        expect(first.session.expiresAt).toBe(start / 1000 + 7 * 24 * 60 * 60)
        expect(yield* (yield* Account).state(first.session.account)).toMatchObject({
          _tag: 'Registered',
          wallets: [wallet(ada.address)],
        })
        expect(yield* (yield* WalletClaim).state(wallet(ada.address))).toEqual({
          _tag: 'Claimed',
          account: first.session.account,
        })
        expect(chain.asked.methods).toEqual([])
      }),
      chain.client,
    )
  })

  it.effect('signs one wallet in to one account however many first sign-ins race', () =>
    inWorld(
      Effect.gen(function* () {
        const signatures = yield* Effect.all([challenged(ada), challenged(ada), challenged(ada)])
        const sessions = yield* Effect.forEach(signatures, verified, { concurrency: 'unbounded' })
        expect(new Set(sessions.map(({ session }) => session.account)).size).toBe(1)
      }),
    ),
  )

  it.effect('signs a contract account in with a signature it accepts (ERC-1271), asking the fake chain', () => {
    const chain = fakeArc()
    return inWorld(
      Effect.gen(function* () {
        const { session } = yield* signInAs(ben, smartWallet.address)
        expect(session.wallet).toBe(wallet(smartWallet.address))
        expect(chain.asked.methods).toEqual(['eth_call'])
        expect(yield* refusalOf(signInAs(ada, smartWallet.address))).toBe('bad_signature')
      }),
      chain.client,
    )
  })

  it.effect('refuses a signature by another key than the wallet’s', () =>
    inWorld(
      Effect.gen(function* () {
        const { message } = yield* (yield* SignIn).challenge(site, ada.address)
        expect(yield* refusalOf(verified({ message, signature: yield* signed(ben, message) }))).toBe('bad_signature')
      }),
    ),
  )

  it.effect('refuses a message for another site, or another chain', () =>
    inWorld(
      Effect.gen(function* () {
        const elsewhere = siteOf(new URL('https://sidequest.example'))
        const { message, signature } = yield* challenged(ada)
        expect(yield* refusalOf((yield* SignIn).verify(elsewhere, message, signature))).toBe('wrong_domain')
        const otherChain = message.replace('Chain ID: 5042002', 'Chain ID: 1')
        expect(yield* refusalOf(verified({ message: otherChain, signature: yield* signed(ada, otherChain) }))).toBe(
          'wrong_chain',
        )
        // Refused before its nonce was spent: the message still signs Ada in.
        expect((yield* verified({ message, signature })).session.wallet).toBe(wallet(ada.address))
      }),
    ),
  )

  it.effect('refuses a challenge signed and sent back after it expired', () =>
    inWorld(
      Effect.gen(function* () {
        const signature = yield* challenged(ada)
        yield* TestClock.adjust('5 minutes')
        expect(yield* refusalOf(verified(signature))).toBe('expired')
      }),
    ),
  )

  it.effect('consumes a nonce once: a replayed or concurrent second use, or another wallet’s, is refused', () =>
    inWorld(
      Effect.gen(function* () {
        const signature = yield* challenged(ada)
        yield* verified(signature)
        expect(yield* refusalOf(verified(signature))).toBe('unknown_nonce')

        const raced = yield* challenged(ada)
        const outcomes = yield* Effect.forEach([raced, raced, raced], (attempt) => Effect.result(verified(attempt)), {
          concurrency: 'unbounded',
        })
        expect(outcomes.filter(Result.isSuccess)).toHaveLength(1)

        // Ben signs a message carrying the nonce issued to Ada.
        const nonce = /Nonce: (\w+)/.exec((yield* challenged(ada)).message)?.[1] ?? ''
        const stolen = createSiweMessage({
          scheme: 'https',
          domain: site.domain,
          uri: site.origin,
          address: ben.address,
          version: '1',
          chainId: 5042002,
          nonce,
          issuedAt: DateTime.toDateUtc(DateTime.makeUnsafe(start)),
        })
        expect(yield* refusalOf(verified({ message: stolen, signature: yield* signed(ben, stolen) }))).toBe(
          'unknown_nonce',
        )
      }),
    ),
  )

  it.effect('answers Unavailable when a contract account’s check cannot reach the chain', () =>
    inWorld(
      Effect.gen(function* () {
        expect(yield* refusalOf(signInAs(ben, smartWallet.address))).toBe('unavailable')
      }),
      // Nothing listens on the discard port.
      createPublicClient({ transport: http('http://127.0.0.1:9', { retryCount: 0 }) }),
    ),
  )
})

describe('sessions', () => {
  it.effect('store only the token’s SHA-256, and end when they expire or are revoked', () => {
    const world = signInWorld(fakeArc().client)
    return Effect.gen(function* () {
      yield* TestClock.setTime(start)
      const sessions = yield* Sessions
      const { token, session } = yield* signInAs(ada)
      const stored = world.sqlite.prepare('SELECT token_hash FROM sessions').all()
      expect(stored).toEqual([{ token_hash: createHash('sha256').update(Redacted.value(token)).digest('hex') }])
      const now = start / 1000
      expect(Option.getOrUndefined(yield* sessions.find(Redacted.value(token), now))).toEqual(session)
      expect(Option.isNone(yield* sessions.find(Redacted.value(token), session.expiresAt))).toBe(true)
      expect(Option.isNone(yield* sessions.find('not a token', now))).toBe(true)
      yield* sessions.revoke(Redacted.value(token), now)
      expect(Option.isNone(yield* sessions.find(Redacted.value(token), now))).toBe(true)
    }).pipe(Effect.provide(world.layer))
  })
})

/** An Api exposing one command that needs the `Session` middleware, to drive the middleware as a client does. */
class SessionProbe extends Domain.Api('SessionProbe', RenameAccount) {}

const Unauthorized = Schema.Struct({ _tag: Schema.Literal('Unauthorized') })

describe('the Session middleware', () => {
  it.effect('lets the person whose session cookie a request carries act as their account, and nobody else', () =>
    inWorld(
      Effect.scoped(
        Effect.gen(function* () {
          const { token, session } = yield* signInAs(ada)
          const client = yield* SessionProbe.testClient
          const cookie = { cookie: `theme=dark; ${sessionCookieName}=${Redacted.value(token)}` }
          const rename = (headers: Record<string, string>) =>
            client.RenameAccount({ target: session.account, displayName: 'Ada L.' }, { headers })
          yield* rename(cookie)
          expect(yield* (yield* Account).state(session.account)).toMatchObject({ displayName: 'Ada L.' })
          expect(Schema.is(Unauthorized)(yield* Effect.flip(rename({})))).toBe(true)
          yield* (yield* Sessions).revoke(Redacted.value(token), start / 1000)
          expect(Schema.is(Unauthorized)(yield* Effect.flip(rename(cookie)))).toBe(true)
        }),
      ),
    ),
  )
})
