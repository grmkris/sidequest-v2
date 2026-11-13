import { Array, Effect, Option, Schema } from 'effect'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import { Command, type Update } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { SidequestClient } from './Api.ts'
import { failedWith, Problem } from './Problem.ts'
import { SignerIdentity, Signers } from './Signer.ts'

// Who the person is on the marketplace pages: their Nostr signer's key (ADR-0003, decision 3), and what the index knows
// of it: the name they go by and the wallets linked to it by a verified link. The pages act as this key; without a
// signer ready, an action leads to the identity page and back.

// MODEL

/** What the index knows of the key: its profile's name and its verified wallets (CAIP-10 accounts). */
export const Standing = defineTaggedUnion({
  Reading: {},
  Known: { maybeName: Schema.Option(Schema.String), wallets: Schema.Array(Schema.String) },
  Failed: { problem: Problem },
})
export type Standing = typeof Standing.Type

/** `Detecting` until the browser looked (the server renders that); `NoSigner` when nothing signs in this tab: no key
 * unlocked here and no extension remembered; `Ready` signs, as the key it names. */
export const Me = defineTaggedUnion({
  Detecting: {},
  NoSigner: {},
  Ready: { identity: SignerIdentity, standing: Standing },
})
export type Me = typeof Me.Type

/** The key the pages act as, once a signer is ready. */
export const pubkeyOf = (me: Me): Option.Option<string> =>
  Me.guards.Ready(me) ? Option.some(me.identity.pubkey) : Option.none()

/** The person's verified wallet on `network` (a CAIP-2 chain), which a proposal names to be paid to. */
export const walletOn = (me: Me, network: string): Option.Option<string> =>
  Me.guards.Ready(me) && Standing.guards.Known(me.standing)
    ? Array.findFirst(me.standing.wallets, (account) => account.startsWith(`${network}:`))
    : Option.none()

// MESSAGE

export const Message = defineMessageUnion({
  CompletedDetectMe: { maybeIdentity: Schema.Option(SignerIdentity) },
  SucceededReadMe: {
    pubkey: Schema.String,
    maybeName: Schema.Option(Schema.String),
    wallets: Schema.Array(Schema.String),
  },
  FailedReadMe: { pubkey: Schema.String, problem: Problem },
})
export type Message = typeof Message.Type

// COMMAND

/** Who signs in this tab: a key unlocked here, or a remembered extension that is still in the browser (it signs when
 * asked, see `Signers.resume`). A local key waiting for its password does not sign until it is unlocked. */
export const DetectMe = Command.define('DetectMe', {
  messages: [Message.CompletedDetectMe],
  execute: Effect.gen(function* () {
    const detected = yield* (yield* Signers).detect
    return Message.CompletedDetectMe({
      maybeIdentity: Option.orElse(detected.maybeUnlocked, () =>
        Option.filter(detected.maybeRemembered, (identity) => detected.extension && identity.signerKind === 'nip07'),
      ),
    })
  }),
})

/** What the index knows of the key. Read right after the identity page may have changed it, so it revalidates. */
export const ReadMe = Command.define('ReadMe', {
  args: { pubkey: Schema.String },
  messages: [Message.SucceededReadMe, Message.FailedReadMe],
  execute: ({ pubkey }) =>
    Effect.gen(function* () {
      const api = yield* (yield* SidequestClient).api
      const person = yield* api.events
        .person({ params: { pubkey } })
        .pipe(Effect.provideService(FetchHttpClient.RequestInit, { cache: 'no-cache' }))
      return Message.SucceededReadMe({
        pubkey,
        maybeName: Option.fromNullishOr(person.profile?.name),
        wallets: Array.map(person.wallets, (wallet) => wallet.account),
      })
    }).pipe(
      Effect.catchTag('NotIndexed', () =>
        Effect.succeed(Message.SucceededReadMe({ pubkey, maybeName: Option.none(), wallets: [] })),
      ),
      Effect.catch(failedWith((payload) => Message.FailedReadMe({ pubkey, ...payload }))),
    ),
})

// UPDATE

type UpdateReturn = Update.Return<Me, Message, Signers | SidequestClient>

/** A signer became ready (here or on the identity page): the key, and what the index knows of it, to be read. */
export const signerReady = (identity: SignerIdentity): UpdateReturn => ({
  model: Me.Ready({ identity, standing: Standing.Reading() }),
  commands: [ReadMe({ pubkey: identity.pubkey })],
})

/** What the identity page read of the key, for the key the pages act as. */
export const standingRead = (me: Me, pubkey: string, standing: Standing): Me =>
  Me.guards.Ready(me) && me.identity.pubkey === pubkey ? Me.Ready({ identity: me.identity, standing }) : me

export const update = (me: Me, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    CompletedDetectMe: ({ maybeIdentity }) =>
      Option.match(maybeIdentity, { onNone: () => ({ model: Me.NoSigner() }), onSome: signerReady }),
    SucceededReadMe: ({ pubkey, maybeName, wallets }) => ({
      model: standingRead(me, pubkey, Standing.Known({ maybeName, wallets })),
    }),
    FailedReadMe: ({ pubkey, problem }) => ({ model: standingRead(me, pubkey, Standing.Failed({ problem })) }),
  })
