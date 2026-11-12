import { unixSeconds } from '@sidequest/domain/Authority'
import { type AccountId, NotSignedIn, sessionCookieName, SignedIn, SignedInAccount } from '@sidequest/protocol'
import { DateTime, Effect, Layer, Option, Redacted } from 'effect'
import type { HttpServerRequest } from 'effect/http/HttpServerRequest'
import { Sessions } from '../SignIn/Sessions.ts'

/** The account of the live session a session cookie's token names, if any. */
const accountOf = Effect.fnUntraced(function* (sessions: Sessions['Service'], token: string | undefined) {
  if (token === undefined) return Option.none<AccountId>()
  const found = yield* sessions.find(token, unixSeconds(yield* DateTime.now))
  return Option.map(found, ({ account }) => account)
})

/** {@link SignedIn}: the session cookie must name a live session, whose account the endpoint then acts as. */
export const SignedInLive = Layer.effect(
  SignedIn,
  Effect.gen(function* () {
    const sessions = yield* Sessions
    return SignedIn.of({
      session: (httpEffect, { credential }) =>
        Effect.gen(function* () {
          const account = yield* accountOf(sessions, Redacted.value(credential))
          if (Option.isNone(account)) return yield* new NotSignedIn()
          return yield* Effect.provideService(httpEffect, SignedInAccount, account.value)
        }),
    })
  }),
)

/**
 * The account a request's session cookie names, for the reads anyone may make whose answer depends on who asks. No
 * cookie, or one that names no live session, is nobody.
 */
export const visitorOf = (sessions: Sessions['Service'], request: HttpServerRequest) =>
  accountOf(sessions, request.cookies[sessionCookieName]).pipe(Effect.map(Option.getOrUndefined))
