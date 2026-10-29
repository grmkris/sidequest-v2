import * as D1Client from '@effect/sql-d1/D1Client'
import { Auth, Email, Operations, Password, Proofs } from '@yielded/auth'
import { hooksLayer } from '@yielded/auth/Persistence'
import * as WorkerdServices from '@yielded/auth/WorkerdServices'
import { databaseLayer } from '@yielded/auth-persistence-drizzle/D1'
import * as Drizzle from 'drizzle-orm/effect-d1'
import { Effect, Layer, Redacted, Schema } from 'effect'
import { eq } from 'drizzle-orm'
import { accounts } from '@sidequest/db'

import { emailEntryBudgetLayer, passwordAttemptLimiter, type D1Source } from './AttemptLimiter.ts'
import { AccountClaims, requirement } from './config.ts'
import {
  emailDeliveryLayer,
  emailRendererLayer,
  proofDispatchSchedulerLayer,
  type CloudflareEmailSender,
} from './EmailDelivery.ts'
import { emailPersistenceLayer } from './EmailPersistence.ts'
import { AppAuth, Persistence, storage } from './storage.ts'

/** Worker-supplied email entry configuration. Keyrings are dedicated: never the session keys. */
export interface EmailEntryOptions {
  readonly sender: CloudflareEmailSender
  /** `Sidequest <noreply@sidequest.app>` */
  readonly from: string
  /** HMAC keys for six-digit codes (Y/proofs/crypto.ts:44-52); keep retired ids >= 5 minutes. */
  readonly proofKeys: Proofs.ProofKeyring
  /** Signs the private `request-binding` cookie that ties a code to one browser flow. */
  readonly requestBindingKeys: Operations.RequestBindingConfiguration['keyring']
  /** Exact paths a completed entry may return to (Email.EmailReturnTargets.exactRoutes). */
  readonly returnTargets: ReadonlyArray<string>
}

/** The enabled account behind a verified credential, or none. Shared by both sign-in methods. */
const accountClaims = Effect.gen(function* () {
  const drizzle = yield* Drizzle.makeWithDefaults({})
  return Effect.fn('Sidequest.Auth.claims')(function* (input: {
    readonly subjectId: string
    readonly email: string
    readonly emailVerified: boolean
  }) {
    const rows = yield* drizzle.select().from(accounts).where(eq(accounts.id, input.subjectId))
    // A missing or disabled account fails with NoSuchElementError; each resolver maps it.
    const account = yield* Effect.fromNullishOr(rows.find((row) => row.enabled))
    return yield* Schema.decodeUnknownEffect(AccountClaims)({
      accountId: account.id,
      displayName: account.displayName,
      email: input.email,
      emailVerified: input.emailVerified,
    })
  })
})

export const makeAuthRuntime = <R>(raw: D1Source<R>, secret: Redacted.Redacted, email: EmailEntryOptions) => {
  const auth = AppAuth
  // @effect-diagnostics-next-line unstableApiUsage:off -- The pinned Effect D1 adapter is the Worker persistence boundary.
  const sql = Layer.unwrap(Effect.map(raw, (db) => D1Client.layer({ db })))
  const database = databaseLayer.pipe(Layer.provide(sql))

  const passwordClaims = Layer.effect(
    auth.strategies.password.SessionClaims,
    Effect.map(accountClaims, (read) => ({
      resolve: ({ subjectId, credential }) =>
        read({
          subjectId,
          email: credential.identifier.value,
          emailVerified: credential.identifierVerifiedAtMillis !== undefined,
        }).pipe(Effect.mapError(() => Password.PasswordUnavailable.make({}))),
    })),
  ).pipe(Layer.provide(sql))

  // An email credential only exists for a verified address (P/internal/email-native-state.ts:154-160).
  const emailClaims = Layer.effect(
    auth.strategies.email.SessionClaims,
    Effect.map(accountClaims, (read) => ({
      resolve: ({ subjectId, credential }) =>
        read({ subjectId, email: credential.identifier.value, emailVerified: true }).pipe(
          Effect.mapError(() => Email.EmailUnavailable.make({})),
        ),
    })),
  ).pipe(Layer.provide(sql))

  const persistence = Persistence.layer.pipe(
    Layer.provide(Persistence.Config.layer(storage)),
    Layer.provide(database),
    Layer.provide(sql),
  )

  // EmailSignInTargets, ProofPersistence and the email RegistrationAuthority (EmailPersistence.ts).
  const emailPersistence = emailPersistenceLayer.pipe(
    Layer.provide(hooksLayer),
    Layer.provide(database),
    Layer.provide(sql),
  )

  const emailEntry = Layer.mergeAll(
    emailDeliveryLayer(email.sender, email.from),
    emailRendererLayer,
    proofDispatchSchedulerLayer,
    Proofs.ProofKeys.layer(email.proofKeys),
    Auth.RequestBindingConfig.layer({
      // Covers the 5-minute code plus resends; Yielded's maximum is 30 minutes.
      lifetimeMillis: 1_800_000,
      generation: 1,
      keyring: email.requestBindingKeys,
    }),
    Email.EmailReturnTargets.exactRoutes(email.returnTargets),
  )

  return {
    auth,
    layer: auth.layer.pipe(
      Layer.provide(passwordClaims),
      Layer.provide(emailClaims),
      Layer.provide(passwordAttemptLimiter(raw, secret)),
      Layer.provide(emailEntryBudgetLayer(raw, secret)),
      // Closest provider wins: keep the explicit ProofPersistence ahead of `persistence` in case a
      // future managed role (password reset) also provides one.
      Layer.provide(emailPersistence),
      Layer.provide(persistence),
      Layer.provide(emailEntry),
      Layer.provide(WorkerdServices.layer),
      Layer.provide(Auth.AuthConfig.layer({ secret })),
    ),
    sql,
    database,
    requirement,
  }
}
