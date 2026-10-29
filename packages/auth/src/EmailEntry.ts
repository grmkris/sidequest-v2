import { Auth, Email, Hooks, Identity, Operations, Proofs, Schema as AuthSchema, Sessions } from '@yielded/auth'
import { hooksLayer } from '@yielded/auth/Persistence'
import { Context, DateTime, Effect, Layer, Option, Predicate, Schema } from 'effect'
import * as Crypto from 'effect/Crypto'
import * as Base64Url from 'effect/encoding/Base64Url'

import {
  EmailEntryComplete,
  EmailEntryFailure,
  EmailEntryReceipt,
  EmailEntryRequest,
  emailEntryCompletion,
} from './EmailEntryContract.ts'

/** Unified email-code entry: one address field, one six-digit code, one session.
 *
 * Yielded's registration completion never issues a session (Y/email/registration.ts:111-114, :352-382),
 * so this strategy binds Yielded's code sign-in and email registration modules under one namespace
 * (they then share the `email-entry` request binding and `flow/begin`) and decides between them with
 * `EmailSignInTargets.lookup` on both request and completion. A completed registration is followed by
 * the same proof-then-session step Yielded's own sign-in uses (Y/email/module.ts:361-374).
 *
 * Deviation from the reference: the session for a new account is issued from the registration proof.
 * The proof is a fresh, single-use possession proof bound to this flow's private request binding. */

/** 6 digits (set at bind), 5 minutes, 3 attempts, resend after 30 s. Everything else stays at Yielded's defaults. */
const emailCodePolicy: Proofs.ProofPolicy = {
  ...Proofs.defaultProofPolicy,
  lifetimeMillis: 300_000,
  maximumFailedAttempts: 3,
  abuse: { ...Proofs.defaultProofPolicy.abuse, resendCooldownMillis: 30_000 },
}

export const EmailRegistration = Schema.Struct({
  displayName: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
})
export type EmailRegistration = typeof EmailRegistration.Type

/** Deterministic, so request and completion compute the same registration fingerprint (registration.ts:200-216). */
const registrationFor = (email: string): EmailRegistration => ({
  displayName: email.slice(0, Math.max(1, email.indexOf('@'))).slice(0, 64),
})

const encoder = new TextEncoder()

/** Per address, per hour: codes asked for and codes tried. A person needs one or two of each; the
 * budgets bound code guessing for an address to a few hundred tries a day. */
export const emailBudgets = {
  request: { limit: 5, windowMillis: 3_600_000 },
  complete: { limit: 10, windowMillis: 3_600_000 },
} as const

/** Durable per-address budgets, supplied by the host (D1 in `AttemptLimiter.ts`). The same budget
 * applies whether or not the address has an account, so a refusal reveals nothing. */
export class EmailEntryBudget extends Context.Service<
  EmailEntryBudget,
  {
    readonly request: (email: string) => Effect.Effect<boolean>
    readonly complete: (email: string) => Effect.Effect<boolean>
  }
>()('@sidequest/auth/EmailEntryBudget') {}

/** Same classification as Yielded's internal `emailCompletionFailure` (Y/email/errors.ts:116-137). */
const completionFailure = (error: unknown) => {
  if (Schema.is(Hooks.HookDenied)(error)) return error
  if (Schema.is(Sessions.SessionCapabilityUnsupported)(error)) return Email.EmailMethodUnsupported.make({})
  if (
    Schema.is(
      Schema.Union([
        Sessions.SessionInvalid,
        Sessions.SessionConflict,
        Sessions.StaleAuthentication,
        Sessions.PendingAuthenticationInvalid,
      ]),
    )(error)
  )
    return Email.EmailRejected.make({})
  return Email.EmailUnavailable.make({})
}

// Purposes fixed by Yielded's proof modules (Y/email/module.ts:179-181, :477-482).
const signInPurpose = Proofs.ProofPurpose.make('email-code-sign-in')
const registrationPurpose = Proofs.ProofPurpose.make('email-code-registration')

/** The public payloads plus the private request binding the HTTP adapter restores from its cookie. */
const RequestInput = Schema.Struct({ ...EmailEntryRequest.fields, requestBinding: Operations.RequestBindingCredential })
const CompleteInput = Schema.Struct({
  ...EmailEntryComplete.fields,
  requestBinding: Operations.RequestBindingCredential,
})
type CompleteInput = typeof CompleteInput.Type

const bindingDigest = Effect.fn('Sidequest.EmailEntry.bindingDigest')(function* (parts: ReadonlyArray<string>) {
  const crypto = yield* Crypto.Crypto
  const bytes = yield* crypto
    .digest('SHA-256', encoder.encode(JSON.stringify(['sidequest/email-entry/registration-session/v1', ...parts])))
    .pipe(Effect.mapError(() => Email.EmailUnavailable.make({})))
  return AuthSchema.TokenDigest.make(Base64Url.encode(bytes))
})

/** Yielded's code sign-in and email registration, bound to one namespace so they share the
 * `<moduleId>/email-entry` request binding, the `<moduleId>/flow/begin` operation and the
 * `effect-auth/email/<moduleId>/Claims` resolver, plus the two operations the browser calls. */
const bindModules = <Claims extends Auth.ClaimsCodec, const Id extends string, const SessionId extends string>(
  binding: Auth.StrategyBinding<Claims, Id, SessionId>,
) => {
  const moduleId = binding.namespace
  const code = Email.makeCode({ digits: 6, policy: emailCodePolicy }).bind(binding)
  const registration = Email.makeRegistration({
    registration: EmailRegistration,
    digits: 6,
    policy: emailCodePolicy,
  }).bind(binding)

  // Host ingress before any lookup, like Yielded's proofRequestAdmission (Y/proofs/admission.ts).
  const admit = Effect.gen(function* () {
    const request = yield* yield* Proofs.ProofRequestContext
    const limiter = yield* Proofs.HostIngressLimiter
    yield* limiter.check({
      action: `${moduleId}/entry/request`,
      networkKey: request.networkKey,
      ...(request.deviceKey === undefined ? {} : { deviceKey: request.deviceKey }),
    })
  }).pipe(
    Effect.mapError((error) =>
      Predicate.isTagged(error, 'ProofIngressDenied') ? error : Email.EmailUnavailable.make({}),
    ),
  )

  const Request = Operations.makeOperation(`${moduleId}/entry/request`, {
    authorize: () => admit,
    payload: RequestInput,
    success: EmailEntryReceipt,
    error: EmailEntryFailure,
    access: 'any',
    exposure: 'public',
    replay: 'non-idempotent',
  })

  const Complete = Operations.makeOperation(`${moduleId}/entry/complete`, {
    payload: CompleteInput,
    success: emailEntryCompletion(binding.sessions.CompletionResult),
    error: EmailEntryFailure,
    access: 'any',
    exposure: 'public',
    replay: 'single-use',
    credentials: true,
  })

  return { binding, moduleId, code, registration, Request, Complete }
}

type Modules<Claims extends Auth.ClaimsCodec, Id extends string, SessionId extends string> = ReturnType<
  typeof bindModules<Claims, Id, SessionId>
>

/** A known address gets a sign-in code, a new one a registration code; both answer alike. */
const requestHandler = <Claims extends Auth.ClaimsCodec, Id extends string, SessionId extends string>({
  moduleId,
  code,
  registration,
  Request,
}: Modules<Claims, Id, SessionId>) =>
  Request.handlerLayer(
    Effect.fn('Sidequest.EmailEntry.request')(function* (input) {
      // Validate the return target on both branches: only sign-in checks it inside Yielded, and a
      // branch-dependent rejection would reveal whether the address has an account.
      yield* (yield* Email.EmailReturnTargets).resolve(input.returnTarget)
      if (!(yield* (yield* EmailEntryBudget).request(input.email))) return yield* Proofs.ProofIngressDenied.make({})
      const identifier = Identity.LoginIdentifier.make({ namespace: 'email', value: input.email })
      const existing = yield* (yield* Email.EmailSignInTargets).lookup({ moduleId, identifier })
      const receipt = Option.isSome(existing)
        ? yield* (yield* code.SignIn).request({
            flowId: input.flowId,
            requestBinding: input.requestBinding,
            email: input.email,
            returnTarget: input.returnTarget,
            requestId: input.requestId,
            locale: input.locale,
          })
        : yield* (yield* registration.Registrations).request({
            flowId: input.flowId,
            requestBinding: input.requestBinding,
            email: input.email,
            registration: registrationFor(input.email),
            requestId: input.requestId,
            locale: input.locale,
          })
      return { requestId: receipt.requestId, proofId: receipt.reference.proofId, keyId: receipt.reference.keyId }
    }),
  )

/** A new address: commit the registration, then issue the session from the same code. This is
 * the proof-then-session step Yielded's own sign-in takes (Y/email/module.ts:361-374). */
const registerAndSignIn = Effect.fnUntraced(function* <
  Claims extends Auth.ClaimsCodec,
  Id extends string,
  SessionId extends string,
>(
  { binding, moduleId, code, registration }: Modules<Claims, Id, SessionId>,
  input: CompleteInput,
  context: {
    readonly identifier: Identity.LoginIdentifier
    readonly verifiedAt: DateTime.Utc
    readonly returnTarget: typeof Email.SafeReturnTarget.Type
  },
) {
  const { identifier, verifiedAt, returnTarget } = context
  const targets = yield* Email.EmailSignInTargets
  const verified = yield* (yield* code.binding.RequestBinding)
    .verify(input.flowId, input.requestBinding)
    .pipe(
      Effect.mapError((error) =>
        Predicate.isTagged(error, 'RequestBindingInvalid')
          ? Email.EmailRejected.make({})
          : Email.EmailUnavailable.make({}),
      ),
    )
  const plan = yield* (yield* registration.Registrations).planComplete({
    flowId: input.flowId,
    requestBinding: input.requestBinding,
    email: input.email,
    registration: registrationFor(input.email),
    // One registration command per proof; RegistrationAuthority provisions idempotently by proof.
    commandId: Email.EmailCommandId.make(`sidequest-entry:${input.proofId}`),
    reference: { proofId: input.proofId, keyId: input.keyId, purpose: registrationPurpose },
    secret: input.code,
  })
  const registered = yield* (yield* plan.commit).read.pipe(Effect.mapError(() => Email.EmailUnavailable.make({})))
  if (Predicate.isTagged(registered.value, 'Rejected')) return yield* Email.EmailRejected.make({})

  // The proof is consumed and the account exists. From here a failure leaves a usable account
  // and asks for a fresh code, exactly like a failed session step after sign-in.
  const created = yield* targets.lookup({ moduleId, identifier })
  if (Option.isNone(created)) return yield* Email.EmailUnavailable.make({})
  const credential = yield* Email.snapshotEmailCredential(created.value)
  const claims = yield* (yield* code.SessionClaims).resolve({
    subjectId: credential.revision.subjectId,
    credential,
  })
  const evidence: Sessions.AuthenticationEvidence = {
    flowId: Sessions.AuthenticationFlowId.make(input.flowId),
    bindingDigest: yield* bindingDigest([moduleId, input.flowId, verified.verifier, identifier.value]),
    revision: credential.revision,
    proofs: [
      {
        method: 'email-code',
        credentialId: credential.credentialId,
        factors: ['possession'],
        userVerified: false,
        phishingResistant: false,
        verifiedAt,
      },
    ],
  }
  const established = yield* (yield* binding.sessions.AuthenticationCompletion)
    .prepare({ evidence, requirement: credential.requirement, claims })
    .pipe(
      Effect.flatMap((prepared) => prepared.read),
      Effect.mapError(completionFailure),
    )
  return {
    value: { completion: established.value, returnTarget },
    credentialCommands: [...registered.credentialCommands, ...established.credentialCommands],
  }
})

/** Sign in a known address, or create the account for a new one, with the code from the email. */
const completeHandler = <Claims extends Auth.ClaimsCodec, Id extends string, SessionId extends string>(
  modules: Modules<Claims, Id, SessionId>,
) =>
  modules.Complete.credentialHandlerLayer(
    Effect.fn('Sidequest.EmailEntry.complete')(function* (input) {
      const returnTarget = yield* (yield* Email.EmailReturnTargets).resolve(input.returnTarget)
      // Every try counts against the address, so guesses spread over many codes stay bounded.
      if (!(yield* (yield* EmailEntryBudget).complete(input.email))) return yield* Email.EmailRejected.make({})
      // Verification starts here; later claims/session work must not move the proof time.
      const verifiedAt = yield* DateTime.now
      const targets = yield* Email.EmailSignInTargets
      const identifier = Identity.LoginIdentifier.make({ namespace: 'email', value: input.email })
      const existing = yield* targets.lookup({ moduleId: modules.moduleId, identifier })

      if (Option.isSome(existing))
        return yield* (yield* modules.code.SignIn).complete({
          flowId: input.flowId,
          requestBinding: input.requestBinding,
          email: input.email,
          returnTarget: input.returnTarget,
          reference: { proofId: input.proofId, keyId: input.keyId, purpose: signInPurpose },
          secret: input.code,
        })
      return yield* registerAndSignIn(modules, input, { identifier, verifiedAt, returnTarget })
    }),
  )

const bindEntry = <Claims extends Auth.ClaimsCodec, const Id extends string, const SessionId extends string>(
  binding: Auth.StrategyBinding<Claims, Id, SessionId>,
) => {
  const modules = bindModules(binding)
  const { code, registration, Request, Complete } = modules
  const handlers = Layer.mergeAll(requestHandler(modules), completeHandler(modules))

  const strategy = Auth.makeStrategy(
    {
      beginEmail: code.Begin.invoke,
      requestEmailCode: Request.invoke,
      completeEmailCode: Complete.invoke,
    },
    Layer.mergeAll(code.beginLayer, handlers).pipe(
      Layer.provide([code.layer, registration.layer]),
      Layer.provide([code.proof.emailLayer, registration.proof.emailLayer]),
      Layer.provide(code.binding.layer),
      Layer.provide(hooksLayer),
    ),
    { completion: true },
  )

  return Object.freeze({
    strategy,
    /** Provide in live.ts: verified email credential -> AccountClaims. */
    SessionClaims: code.SessionClaims,
    /** Provide in live.ts from `@yielded/auth-persistence-drizzle/D1` (EmailPersistence.ts). */
    RegistrationAuthority: registration.RegistrationAuthority,
    operations: { Begin: code.Begin, Request, Complete },
  })
}

export interface EmailEntryStrategy extends Auth.StrategyTypeLambda {
  readonly type: ReturnType<
    typeof bindEntry<
      Auth.BindingOf<this>['claims'],
      Auth.BindingOf<this>['namespace'],
      Auth.BindingOf<this>['sessionNamespace']
    >
  >
}

/** `strategies: { email: EmailEntry.make() }` binds it to `<Auth namespace>/email`. */
export const make = (): Auth.StrategyDefinition<EmailEntryStrategy> =>
  Object.freeze({ namespace: undefined, bind: bindEntry })
