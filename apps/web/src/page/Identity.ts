import type { NostrEvent } from '@sidequest/nostr'
import { EventInvalidReason, WalletAddress, WalletSignature } from '@sidequest/protocol'
import { Clock, Effect, Option, Schema } from 'effect'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import { Command, Update } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'
import { SidequestClient } from '../Api.ts'
import { Language } from '../Language.ts'
import { failedWith, Problem } from '../Problem.ts'
import { PubkeyHex, type SignerFailed, SignerFailure, type SignerIdentity, Signers } from '../Signer.ts'
import { Connection, Wallet } from '../Wallet.ts'
import * as SignerSetup from './SignerSetup.ts'

// A person's Nostr identity (ADR-0003, decision 3): their signer, the kind-0 profile with their name, and the link of
// their wallet, which the wallet signs (EIP-712 `LinkNostrKey`) and the key signs as a wallet-link event. Both events go
// to the index through `POST /api/events`, and the page shows what the index then knows of the key.

// MODEL

/** Which event the person published. */
export const Publication = Schema.Literals(['profile', 'walletLink'])
export type Publication = typeof Publication.Type

/** The index's typed refusal of an event. */
export const PublishRefusal = defineTaggedUnion({
  Invalid: { reason: EventInvalidReason },
  KindNotIndexed: {},
  TooLarge: {},
  RateLimited: { retryAfterSeconds: Schema.Int },
})
export type PublishRefusal = typeof PublishRefusal.Type

/** What the person last asked for, and where it stands. */
export const Action = defineTaggedUnion({
  Idle: {},
  NameInvalid: {},
  Publishing: { publication: Publication },
  ConnectingWallet: {},
  SigningInWallet: {},
  Published: { publication: Publication },
  Refused: { refusal: PublishRefusal },
  WalletDeclined: {},
  SignerFailed: { reason: SignerFailure },
  Failed: { problem: Problem },
})
export type Action = typeof Action.Type

/** A wallet a key is linked to, as the index labels it. */
export const LinkedAccount = Schema.Struct({
  account: Schema.String,
  verification: Schema.Literals(['verified', 'unverified']),
})
export type LinkedAccount = typeof LinkedAccount.Type

/** What the page shows of what the index knows of the key: the profile's name and the wallets it links. */
export const PersonSummary = Schema.Struct({
  maybeName: Schema.Option(Schema.String),
  wallets: Schema.Array(LinkedAccount),
})
export type PersonSummary = typeof PersonSummary.Type

export const PersonRead = defineTaggedUnion({
  Unread: {},
  Reading: {},
  /** The index has seen nothing signed by this key yet. */
  Unknown: {},
  Read: { person: PersonSummary },
  Failed: { problem: Problem },
})
export type PersonRead = typeof PersonRead.Type

/** The longest name a profile carries, as `@sidequest/nostr` reads it. */
export const maximumName = 100

export const Model = Schema.Struct({
  language: Language,
  setup: SignerSetup.Model,
  name: Schema.String,
  person: PersonRead,
  action: Action,
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  GotSetupMessage: { message: SignerSetup.Message },
  UpdatedName: { value: Schema.String },
  SubmittedProfile: {},
  ClickedLinkWallet: {},
  SucceededConnectWallet: { connection: Connection },
  FailedConnectWallet: { problem: Problem },
  SucceededSignWalletLink: { account: Schema.String, issuedAt: Schema.Int, walletSignature: WalletSignature },
  FailedSignWalletLink: { problem: Problem },
  SucceededPublish: { publication: Publication },
  RefusedPublish: { refusal: PublishRefusal },
  FailedPublish: { problem: Problem },
  FailedSign: { reason: SignerFailure },
  SucceededReadPerson: { person: PersonSummary },
  CompletedReadUnknownPerson: {},
  FailedReadPerson: { problem: Problem },
})
export type Message = typeof Message.Type

// COMMAND

type Services = SidequestClient | Wallet | Signers

const nowSeconds = Effect.map(Clock.currentTimeMillis, (millis) => Math.floor(millis / 1000))

/** The wallet's answer does not make a wallet link the vocabulary accepts (an account or signature of another shape). */
class WalletLinkUnbuildable extends Schema.TaggedError<WalletLinkUnbuildable>()('WalletLinkUnbuildable', {}) {}

/** Signs with the person's signer and publishes through the index, reporting the index's typed refusals as such. */
const publish = <R>(
  publication: Publication,
  signed: Effect.Effect<NostrEvent, SignerFailed | WalletLinkUnbuildable, R>,
) =>
  Effect.gen(function* () {
    const event = yield* signed
    const api = yield* (yield* SidequestClient).api
    yield* api.events.publish({ payload: event })
    return Message.SucceededPublish({ publication })
  }).pipe(
    Effect.catchTags({
      SignerFailed: ({ reason }) => Effect.succeed(Message.FailedSign({ reason })),
      WalletLinkUnbuildable: () =>
        Effect.succeed(Message.FailedPublish({ problem: Problem.WalletFailed({ code: Option.none() }) })),
      EventInvalid: ({ reason }) =>
        Effect.succeed(Message.RefusedPublish({ refusal: PublishRefusal.Invalid({ reason }) })),
      KindNotIndexed: () => Effect.succeed(Message.RefusedPublish({ refusal: PublishRefusal.KindNotIndexed() })),
      EventTooLarge: () => Effect.succeed(Message.RefusedPublish({ refusal: PublishRefusal.TooLarge() })),
      RateLimited: ({ retryAfterSeconds }) =>
        Effect.succeed(Message.RefusedPublish({ refusal: PublishRefusal.RateLimited({ retryAfterSeconds }) })),
    }),
    Effect.catch(failedWith(Message.FailedPublish)),
  )

export const PublishProfile = Command.define('PublishProfile', {
  args: { name: Schema.String },
  messages: [Message.SucceededPublish, Message.RefusedPublish, Message.FailedPublish, Message.FailedSign],
  execute: ({ name }) =>
    publish(
      'profile',
      Effect.gen(function* () {
        const signers = yield* Signers
        const kit = yield* signers.kit
        const signer = yield* signers.active
        return yield* signer.signEvent(kit.profileOf(name, yield* nowSeconds))
      }),
    ),
})

export const ConnectWallet = Command.define('ConnectWallet', {
  messages: [Message.SucceededConnectWallet, Message.FailedConnectWallet],
  execute: Wallet.use((wallet) => wallet.connect).pipe(
    Effect.map((connection) => Message.SucceededConnectWallet({ connection })),
    Effect.catch(failedWith(Message.FailedConnectWallet)),
  ),
})

/** The wallet signs `LinkNostrKey(pubkey, issuedAt)` on the chain it is on; the link names that chain's account. */
export const SignWalletLink = Command.define('SignWalletLink', {
  args: { address: WalletAddress, chainId: Schema.Int, pubkey: PubkeyHex },
  messages: [Message.SucceededSignWalletLink, Message.FailedSignWalletLink],
  execute: ({ address, chainId, pubkey }) =>
    Effect.gen(function* () {
      const kit = yield* (yield* Signers).kit
      const issuedAt = yield* nowSeconds
      const walletSignature = yield* (yield* Wallet).signTypedDataJson(
        address,
        chainId,
        kit.walletLinkTypedDataJson(pubkey, issuedAt, chainId),
      )
      return Message.SucceededSignWalletLink({
        account: `eip155:${chainId}:${address.toLowerCase()}`,
        issuedAt,
        walletSignature,
      })
    }).pipe(Effect.catch(failedWith(Message.FailedSignWalletLink))),
})

export const PublishWalletLink = Command.define('PublishWalletLink', {
  args: { account: Schema.String, issuedAt: Schema.Int, walletSignature: WalletSignature },
  messages: [Message.SucceededPublish, Message.RefusedPublish, Message.FailedPublish, Message.FailedSign],
  execute: ({ account, issuedAt, walletSignature }) =>
    publish(
      'walletLink',
      Effect.gen(function* () {
        const signers = yield* Signers
        const kit = yield* signers.kit
        const signer = yield* signers.active
        const template = yield* kit.walletLinkOf({ address: account, issuedAt, walletSignature })
        if (Option.isNone(template)) {
          return yield* new WalletLinkUnbuildable()
        }
        return yield* signer.signEvent(template.value)
      }),
    ),
})

export const ReadPerson = Command.define('ReadPerson', {
  args: { pubkey: PubkeyHex },
  messages: [Message.SucceededReadPerson, Message.CompletedReadUnknownPerson, Message.FailedReadPerson],
  execute: ({ pubkey }) =>
    Effect.gen(function* () {
      const api = yield* (yield* SidequestClient).api
      // NOTE: the index lets caches keep a person for a minute; this page reads right after publishing, so it
      // revalidates rather than show what the browser's cache kept from before.
      const person = yield* api.events
        .person({ params: { pubkey } })
        .pipe(Effect.provideService(FetchHttpClient.RequestInit, { cache: 'no-cache' }))
      return Message.SucceededReadPerson({
        person: {
          maybeName: Option.fromNullishOr(person.profile?.name),
          wallets: [...person.wallets, ...person.unverifiedWallets].map(({ account, verification }) => ({
            account,
            verification,
          })),
        },
      })
    }).pipe(
      Effect.catchTag('NotIndexed', () => Effect.succeed(Message.CompletedReadUnknownPerson())),
      Effect.catch(failedWith(Message.FailedReadPerson)),
    ),
})

// INIT

type UpdateReturn = Update.Return<Model, Message, Services>

const toSetupMessage = (message: SignerSetup.Message) => Message.GotSetupMessage({ message })

export const init = (language: Language): UpdateReturn => {
  const setupInit = SignerSetup.init(language)
  return {
    model: { language, setup: setupInit.model, name: '', person: PersonRead.Unread(), action: Action.Idle() },
    commands: Command.mapMessages(setupInit.commands, toSetupMessage),
  }
}

// UPDATE

/** The signer, once it is ready. */
export const identityOf = (model: Model): Option.Option<SignerIdentity> =>
  SignerSetup.Step.guards.Ready(model.setup.step) ? Option.some(model.setup.step.identity) : Option.none()

/** Whether something the person asked for is still on its way. */
const busy = (action: Action): boolean =>
  Action.guards.Publishing(action) || Action.guards.ConnectingWallet(action) || Action.guards.SigningInWallet(action)

const withAction = (model: Model, action: Action): Model => modifyFields(model, { action: () => action })

type Step = Update.Step<Model, Message, Services>

const foldSetup = Update.foldChild({
  update: SignerSetup.update,
  read: (model: Model) => Option.some(model.setup),
  write: (model: Model, nextSetup: SignerSetup.Model) => modifyFields(model, { setup: () => nextSetup }),
  toParentMessage: toSetupMessage,
  foldOutMessage: SignerSetup.OutMessage.match<Step>({
    SignerReady:
      ({ identity }) =>
      (model) => ({
        model: modifyFields(model, { person: () => PersonRead.Reading(), action: () => Action.Idle() }),
        commands: [ReadPerson({ pubkey: identity.pubkey })],
      }),
    SignerForgotten: () => (model) => ({
      model: modifyFields(model, { person: () => PersonRead.Unread(), action: () => Action.Idle() }),
    }),
  }),
})

/** Only a ready signer acts, one thing at a time. */
const whenReady = (model: Model, next: (identity: SignerIdentity) => UpdateReturn): UpdateReturn =>
  busy(model.action) ? { model } : Option.match(identityOf(model), { onNone: () => ({ model }), onSome: next })

const submittedProfile = (model: Model): UpdateReturn =>
  whenReady(model, () => {
    const name = model.name.trim()
    return name.length === 0 || name.length > maximumName
      ? { model: withAction(model, Action.NameInvalid()) }
      : {
          model: withAction(model, Action.Publishing({ publication: 'profile' })),
          commands: [PublishProfile({ name })],
        }
  })

/** A wallet that said no is its own state: nothing was signed, and the person may try again. */
const walletFailed = (model: Model, problem: Problem): UpdateReturn => ({
  model: withAction(
    model,
    Problem.guards.WalletRejected(problem) ? Action.WalletDeclined() : Action.Failed({ problem }),
  ),
})

const readAgain = (model: Model) =>
  Option.match(identityOf(model), {
    onNone: () => [],
    onSome: ({ pubkey }) => [ReadPerson({ pubkey })],
  })

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    GotSetupMessage: ({ message: setupMessage }) => foldSetup(model, setupMessage),
    UpdatedName: ({ value }) => ({
      model: modifyFields(model, {
        name: () => value,
        action: (action) => (Action.guards.NameInvalid(action) ? Action.Idle() : action),
      }),
    }),
    SubmittedProfile: () => submittedProfile(model),
    ClickedLinkWallet: () =>
      whenReady(model, () => ({ model: withAction(model, Action.ConnectingWallet()), commands: [ConnectWallet()] })),
    SucceededConnectWallet: ({ connection }) =>
      Option.match(identityOf(model), {
        onNone: () => ({ model: withAction(model, Action.Idle()) }),
        onSome: ({ pubkey }) => ({
          model: withAction(model, Action.SigningInWallet()),
          commands: [SignWalletLink({ address: connection.address, chainId: connection.chainId, pubkey })],
        }),
      }),
    FailedConnectWallet: ({ problem }) => walletFailed(model, problem),
    SucceededSignWalletLink: ({ account, issuedAt, walletSignature }) => ({
      model: withAction(model, Action.Publishing({ publication: 'walletLink' })),
      commands: [PublishWalletLink({ account, issuedAt, walletSignature })],
    }),
    FailedSignWalletLink: ({ problem }) => walletFailed(model, problem),
    SucceededPublish: ({ publication }) => ({
      model: modifyFields(model, {
        action: () => Action.Published({ publication }),
        person: () => PersonRead.Reading(),
      }),
      commands: readAgain(model),
    }),
    RefusedPublish: ({ refusal }) => ({ model: withAction(model, Action.Refused({ refusal })) }),
    FailedPublish: ({ problem }) => ({ model: withAction(model, Action.Failed({ problem })) }),
    FailedSign: ({ reason }) => ({ model: withAction(model, Action.SignerFailed({ reason })) }),
    SucceededReadPerson: ({ person }) => ({
      model: modifyFields(model, {
        person: () => PersonRead.Read({ person }),
        name: (name) => (name === '' ? Option.getOrElse(person.maybeName, () => '') : name),
      }),
    }),
    CompletedReadUnknownPerson: () => ({ model: modifyFields(model, { person: () => PersonRead.Unknown() }) }),
    FailedReadPerson: ({ problem }) => ({
      model: modifyFields(model, { person: () => PersonRead.Failed({ problem }) }),
    }),
  })
