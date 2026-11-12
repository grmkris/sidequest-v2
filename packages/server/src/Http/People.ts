import type * as Domain from '@alchemy.run/domain'
import type { Internals } from '@alchemy.run/domain/Model'
import type { Actor } from '@sidequest/domain/Actor'
import { CurrentActor } from '@sidequest/domain/CurrentActor.context'
import { PeopleApi } from '@sidequest/domain/People.api'
import { Session, Unauthorized } from '@sidequest/domain/Session.middleware'
import { type AccountId, SignedInAccount } from '@sidequest/protocol'
import { Context, Effect, Layer, type Scope } from 'effect'
import { type ModelError, refused } from './Refusals.ts'

/** The {@link PeopleApi} client: its commands as methods, its reads as namespaces. */
export type People = Domain.Api.Client<(typeof PeopleApi.entries)[number]>

/** The `Session` middleware for a caller the HTTP layer identified already: it provides that person, and no one else. */
const trusting =
  (actor: Actor): Session['Service'] =>
  (effect) =>
    Effect.provideService(effect, CurrentActor, actor)

/** The `Session` middleware for a caller with no session: every entry that needs one refuses. */
const anonymous: Session['Service'] = () => Effect.fail(new Unauthorized())

/**
 * The model as one caller reaches it: the {@link PeopleApi}, in process, with every command's `decide` and every
 * read's `validate` judging that caller. The HTTP layer has verified the session cookie (`SignedIn`) by then, so the
 * Api's `Session` middleware trusts the account it was given rather than reading the cookie again.
 *
 * The pinned `@alchemy.run/domain` (2.0.0-beta.84) has no `clientInProcess`; its `testClient` is the same in-process
 * client (the Api's handlers behind Effect RPC's no-serialization transport, each entry's middleware running), so it
 * is built per request, in the request's scope, as the docs say to build `clientInProcess` in a Worker.
 */
export class PeopleClients extends Context.Service<
  PeopleClients,
  { readonly as: (account: AccountId | undefined) => Effect.Effect<People, never, Scope.Scope> }
>()('Sidequest/PeopleClients') {
  static readonly layer = Layer.effect(
    PeopleClients,
    Effect.gen(function* () {
      const model = yield* Effect.context<Internals>()
      return PeopleClients.of({
        as: (account) =>
          PeopleApi.testClient.pipe(
            Effect.provideService(Session, account === undefined ? anonymous : trusting({ account })),
            Effect.provide(model),
          ),
      })
    }),
  )
}

/**
 * The model as the signed-in person, for one group's handlers: `ask` runs a read or a command and answers with its
 * result, `send` sends one command and answers with no content. Both answer the model's refusals as the API's errors.
 */
export const signedIn = (clients: PeopleClients['Service']) => {
  const ask = <A, E extends ModelError, R>(use: (people: People) => Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const people = yield* clients.as(yield* SignedInAccount)
      return yield* use(people)
    }).pipe(Effect.scoped, refused)
  const send = <E extends ModelError, R>(use: (people: People) => Effect.Effect<unknown, E, R>) =>
    Effect.asVoid(ask(use))
  return { ask, send }
}
