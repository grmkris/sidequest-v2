import { AuthContract, Email, Hooks, Operations, Proofs, Schema as AuthSchema } from '@yielded/auth'
import { Predicate, Schema } from 'effect'

/** Browser-safe schemas for unified email-code entry. The server strategy (EmailEntry.ts) adds the
 * private `requestBinding` field, which the HTTP adapter restores from the `request-binding` cookie
 * (Y/auth/actions.ts:167-179); browsers never send it. */

/** The code email is written in the catalog locale the browser is showing. */
const EmailEntryLocale = Schema.Literals(['en', 'sl'])

// Same wire shape as Yielded's own email input (Y/email/module.ts:57): trimmed and lower-cased on decode.
const EmailAddress = Schema.String.check(Schema.isMaxLength(320)).pipe(Schema.decodeTo(AuthSchema.Email))
const ReturnTarget = Schema.String.check(Schema.isMaxLength(2048))
const ProofKeyId = Proofs.ProofReference.fields.keyId

const EmailEntryBegin = Schema.Struct({ flowId: Operations.RequestBindingFlowId })

export const EmailEntryRequest = Schema.Struct({
  flowId: Operations.RequestBindingFlowId,
  email: EmailAddress,
  returnTarget: ReturnTarget,
  requestId: Proofs.ProofRequestId,
  locale: EmailEntryLocale,
})

/** A proof reference without its purpose: `email-code-sign-in` and `email-code-registration` would
 * otherwise tell the caller whether the address has an account. The server recomputes it. */
export const EmailEntryReceipt = Schema.Struct({
  requestId: Proofs.ProofRequestId,
  proofId: Proofs.ProofId,
  keyId: ProofKeyId,
})

export const EmailEntryComplete = Schema.Struct({
  flowId: Operations.RequestBindingFlowId,
  email: EmailAddress,
  returnTarget: ReturnTarget,
  proofId: Proofs.ProofId,
  keyId: ProofKeyId,
  code: Schema.RedactedFromValue(Schema.String.check(Schema.isPattern(/^\d{6}$/))),
})

/** Wrong, expired and exhausted codes are all `EmailRejected` by design (Y/email/errors.ts:116-137). */
export const EmailEntryFailure = Schema.Union([
  Email.EmailRejected,
  Email.EmailUnavailable,
  Email.EmailActionRequired,
  Email.EmailMethodUnsupported,
  Hooks.HookDenied,
  /** Per-network request throttling only; per-address limits suppress silently. */
  Proofs.ProofIngressDenied,
])

export const emailEntryCompletion = <S extends Schema.Top>(completion: S) =>
  Schema.Struct({ completion, returnTarget: Email.SafeReturnTarget })

type Completion =
  | { readonly _tag: 'Authenticated'; readonly session: { readonly subjectId: AuthSchema.SubjectId } }
  | { readonly _tag: 'PendingAuthentication' }

/** Actions bound to the `email` strategy of `makeAuth()`; method names match EmailEntry.ts. */
export const emailEntryActions = <S extends Schema.Codec<Completion, unknown, unknown, unknown>>(sessions: {
  readonly CompletionResult: S
}) => ({
  beginEmail: AuthContract.action({
    payload: EmailEntryBegin,
    success: Operations.RequestBindingPublic,
    error: EmailEntryFailure,
    mode: 'mutation',
    credentials: true,
    strategy: 'email',
    method: 'beginEmail',
  }),
  requestEmailCode: AuthContract.action({
    payload: EmailEntryRequest,
    success: EmailEntryReceipt,
    error: EmailEntryFailure,
    mode: 'mutation',
    strategy: 'email',
    method: 'requestEmailCode',
    requestFields: { requestBinding: 'request-binding' },
  }),
  completeEmailCode: AuthContract.action({
    payload: EmailEntryComplete,
    success: emailEntryCompletion(sessions.CompletionResult),
    error: EmailEntryFailure,
    mode: 'mutation',
    replay: 'single-use',
    credentials: true,
    strategy: 'email',
    method: 'completeEmailCode',
    requestFields: { requestBinding: 'request-binding' },
    subject: {
      fromSuccess: (value) =>
        'completion' in value && Predicate.isTagged(value.completion, 'Authenticated')
          ? value.completion.session.subjectId
          : undefined,
      sessionFromSuccess: (value) =>
        'completion' in value && Predicate.isTagged(value.completion, 'Authenticated')
          ? value.completion.session
          : undefined,
    },
  }),
})
