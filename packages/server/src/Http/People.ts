import type * as Domain from '@alchemy.run/domain'
import type { Internals } from '@alchemy.run/domain/Model'
import type { Actor, Party } from '@sidequest/domain/Actor'
import { CurrentActor } from '@sidequest/domain/CurrentActor.context'
import { PeopleApi } from '@sidequest/domain/People.api'
import { Session, Unauthorized } from '@sidequest/domain/Session.middleware'
import { SignedInAccount } from '@sidequest/protocol'
import { Context, Effect, Layer, Option, type Scope } from 'effect'
import { Escrow } from '../Settlement/Escrow.ts'
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
 * read's `validate` judging that caller. The transport has verified who it is by then (the session cookie for HTTP's
 * `SignedIn`, an agent's bearer token for MCP), so the Api's `Session` middleware trusts the party it was given,
 * a person or an agent with its grant, rather than reading a credential again.
 *
 * The pinned `@alchemy.run/domain` (2.0.0-beta.84) has no `clientInProcess`; its `testClient` is the same in-process
 * client (the Api's handlers behind Effect RPC's no-serialization transport, each entry's middleware running), so it
 * is built per request, in the request's scope, as the docs say to build `clientInProcess` in a Worker.
 */
export class PeopleClients extends Context.Service<
  PeopleClients,
  {
    readonly as: (party: Party | undefined) => Effect.Effect<People, never, Scope.Scope>
    /** The escrow's fee in basis points, which a worker's view shows; none while settlement is not configured. */
    readonly feeBps: Option.Option<number>
  }
>()('Sidequest/PeopleClients') {
  static readonly layer = Layer.effect(
    PeopleClients,
    Effect.gen(function* () {
      const model = yield* Effect.context<Internals>()
      const escrow = Option.flatten(yield* Effect.serviceOption(Escrow))
      return PeopleClients.of({
        feeBps: Option.map(escrow, (service) => service.chain.feeBps),
        as: (party) =>
          PeopleApi.testClient.pipe(
            Effect.provideService(Session, party === undefined ? anonymous : trusting(party)),
            Effect.provide(model),
          ),
      })
    }),
  )
}

/**
 * The model as the party `who` names, for one call: `ask` runs a read or a command and answers with its result,
 * `send` sends one command and answers with no content. Both answer the model's refusals as the API's errors.
 */
const callerAs = <RP>(clients: PeopleClients['Service'], who: Effect.Effect<Party, never, RP>) => {
  const ask = <A, E extends ModelError, R>(use: (people: People) => Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const people = yield* clients.as(yield* who)
      return yield* use(people)
    }).pipe(Effect.scoped, refused)
  const send = <E extends ModelError, R>(use: (people: People) => Effect.Effect<unknown, E, R>) =>
    Effect.asVoid(ask(use))
  return { ask, send }
}

/** The model as the signed-in person, for one group's handlers. */
export const signedIn = (clients: PeopleClients['Service']) =>
  callerAs(
    clients,
    Effect.map(SignedInAccount, (account): Party => ({ account })),
  )

/** The model as an agent a bearer token let in, acting for its operator within its grant. */
export const actingAs = (clients: PeopleClients['Service'], party: Party) => callerAs(clients, Effect.succeed(party))
