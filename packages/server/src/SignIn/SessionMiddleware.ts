import type { Actor } from '@sidequest/domain/Actor'
import { unixSeconds } from '@sidequest/domain/Authority'
import { CurrentActor } from '@sidequest/domain/CurrentActor.context'
import { Session, Unauthorized } from '@sidequest/domain/Session.middleware'
import { sessionCookieName } from '@sidequest/protocol'
import { DateTime, Effect, Layer, Option } from 'effect'
import * as Cookies from 'effect/http/Cookies'
import type * as Headers from 'effect/http/Headers'
import { Sessions } from './Sessions.ts'

/**
 * The domain's `Session` middleware: who sent a command, from the request's headers. A person is the account of the
 * session their cookie names. Agents will authenticate with an MCP bearer token bound to one agent; its resolution
 * joins {@link actorOf} as a second credential, giving the operator's account with the agent and its grant.
 * A request with neither is `Unauthorized`. The session store not answering is a defect, not a refusal.
 */
export const SessionLive = Layer.effect(
  Session,
  Effect.gen(function* () {
    const sessions = yield* Sessions

    const person = Effect.fn('Sidequest.Session.person')(function* (headers: Headers.Headers) {
      const token = Cookies.parseHeader(headers.cookie ?? '')[sessionCookieName]
      if (token === undefined) return Option.none<Actor>()
      const found = yield* sessions.find(token, unixSeconds(yield* DateTime.now))
      return Option.map(found, ({ account }): Actor => ({ account }))
    })

    const actorOf = (headers: Headers.Headers) => person(headers).pipe(Effect.orDie)

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
