import { unixSeconds } from '@sidequest/domain/Authority'
import { NotSignedIn, SessionCookie, sessionCookieName, SidequestApi, SignInRefused } from '@sidequest/protocol'
import { DateTime, Duration, Effect, Option } from 'effect'
import type { Cookie } from 'effect/http/Cookies'
import type { HttpServerRequest } from 'effect/http/HttpServerRequest'
import { HttpApiBuilder } from 'effect/http-api'
import { isHex } from 'viem'
import { Sessions, sessionSeconds } from './Sessions.ts'
import { SignIn } from './SignIn.ts'
import { siteOf } from './Siwe.ts'

/**
 * The session cookie's attributes: with its `__Host-` name, only over HTTPS (`Secure`, the default), for the whole
 * site and no other host (`Path=/`, no `Domain`), out of scripts' reach (`HttpOnly`, the default), and sent on
 * top-level navigation from other sites but not on their requests (`SameSite=Lax`).
 */
export const sessionCookieOptions = {
  path: '/',
  sameSite: 'lax',
  maxAge: Duration.seconds(sessionSeconds),
} as const satisfies Cookie['options']

const now = Effect.map(DateTime.now, unixSeconds)

/** The site a request came to: the URL the client asked for, which the edge forwards unchanged. */
const siteOfRequest = (request: HttpServerRequest) => siteOf(new URL(request.originalUrl))

/** The `session` group of the HTTP API: wallet sign-in, the current session and sign-out. */
export const sessionHandlers = HttpApiBuilder.group(SidequestApi, 'session', (handlers) =>
  Effect.gen(function* () {
    const signIn = yield* SignIn
    const sessions = yield* Sessions
    return handlers
      .handle('challenge', ({ payload, request }) => signIn.challenge(siteOfRequest(request), payload.address))
      .handle('verify', ({ payload: { message, signature }, request }) =>
        Effect.gen(function* () {
          if (!isHex(signature, { strict: true })) return yield* new SignInRefused({ reason: 'malformed' })
          const { token, session } = yield* signIn.verify(siteOfRequest(request), message, signature)
          yield* HttpApiBuilder.securitySetCookie(SessionCookie, token, sessionCookieOptions)
          return session
        }),
      )
      .handle('current', ({ request }) =>
        Effect.gen(function* () {
          const token = request.cookies[sessionCookieName]
          const found = token === undefined ? Option.none() : yield* sessions.find(token, yield* now)
          return yield* Option.match(found, { onNone: () => Effect.fail(new NotSignedIn()), onSome: Effect.succeed })
        }),
      )
      .handle('signOut', ({ request }) =>
        Effect.gen(function* () {
          const token = request.cookies[sessionCookieName]
          if (token !== undefined) yield* sessions.revoke(token, yield* now)
          yield* HttpApiBuilder.securitySetCookie(SessionCookie, '', { ...sessionCookieOptions, maxAge: 0 })
        }),
      )
  }),
)
