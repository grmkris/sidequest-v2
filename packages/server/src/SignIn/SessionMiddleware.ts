import type { Actor } from '@sidequest/domain/Actor'
import { unixSeconds } from '@sidequest/domain/Authority'
import { CurrentActor } from '@sidequest/domain/CurrentActor.context'
import { Session, Unauthorized } from '@sidequest/domain/Session.middleware'
import { sessionCookieName } from '@sidequest/protocol'
import { DateTime, Effect, Layer, Option } from 'effect'
import * as Cookies from 'effect/http/Cookies'
import type * as Headers from 'effect/http/Headers'
import { AgentAccess, bearerOf } from '../Agents/AgentAccess.ts'
import { Sessions } from './Sessions.ts'

/**
 * The domain's `Session` middleware: who sent a command, from the request's headers. An agent is the one its bearer
 * token names (`Authorization: Bearer`), acting as its operator's account within its grant as it stands now; a
 * request with a bearer token is judged on it alone, never on a cookie beside it. A person is the account of the
 * session their cookie names. A request with neither, or with one the server does not accept, is `Unauthorized`.
 * The stores not answering is a defect, not a refusal.
 */
export const SessionLive = Layer.effect(
  Session,
  Effect.gen(function* () {
    const sessions = yield* Sessions
    const access = yield* AgentAccess

    const person = Effect.fn('Sidequest.Session.person')(function* (headers: Headers.Headers) {
      const token = Cookies.parseHeader(headers.cookie ?? '')[sessionCookieName]
      if (token === undefined) return Option.none<Actor>()
      const found = yield* sessions.find(token, unixSeconds(yield* DateTime.now))
      return Option.map(found, ({ account }): Actor => ({ account }))
    })

    const agent = Effect.fn('Sidequest.Session.agent')(function* (token: string) {
      return yield* access.admit(token).pipe(
        Effect.map(({ actor }): Option.Option<Actor> => Option.some(actor)),
        Effect.catchTag('AccessDenied', () => Effect.succeed(Option.none<Actor>())),
      )
    })

    const actorOf = (headers: Headers.Headers) =>
      Option.match(bearerOf(headers.authorization), { onNone: () => person(headers), onSome: agent }).pipe(Effect.orDie)

    return (effect, { headers }) =>
      Effect.flatMap(
        actorOf(headers),
        Option.match({
          onNone: () => Effect.fail(new Unauthorized()),
          onSome: (actor) => Effect.provideService(effect, CurrentActor, actor),
        }),
      )
  }),
)
