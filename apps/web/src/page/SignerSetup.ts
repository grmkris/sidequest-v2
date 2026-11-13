import { Effect, Option, Redacted, Schema } from 'effect'
import { Command, type Update } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'
import { Language } from '../Language.ts'
import { Password, PubkeyHex, SignerFailure, SignerIdentity, Signers } from '../Signer.ts'

// Choosing a Nostr signer, in ADR-0003's order: the browser's extension when it has one; else, where the stage offers
// passkeys and the browser has WebAuthn, a key a passkey derives (with an encrypted backup offered, which the person
// takes or declines); else a key made here (with a backup the person must confirm they saved). A key is also restored
// from a backup, or found with a passkey made on another device. After a reload, a local key unlocks with its password
// and a passkey key with its passkey.

// MODEL

/** A form being filled in, or its work running (scrypt takes a second or more). */
const FormState = Schema.Literals(['editing', 'working'])

/** Where the person is in choosing a signer. `Choosing` is "no signer"; `Locked` is a local key kept in this browser,
 * waiting for its password, and `PasskeyLocked` a passkey key waiting for its passkey; `Ready` signs. A passkey key
 * just made waits in `PasskeyMade` for the backup choice, and one found that is not the remembered key waits in
 * `PasskeyOtherKey` for the person to choose. */
export const Step = defineTaggedUnion({
  Detecting: {},
  Choosing: {},
  ConnectingExtension: {},
  Creating: { password: Password, confirmation: Password, form: FormState },
  BackingUp: { pubkey: PubkeyHex, ncryptsec: Schema.String, saved: Schema.Boolean },
  Restoring: { ncryptsec: Schema.String, password: Password, form: FormState },
  Locked: { pubkey: PubkeyHex, password: Password, form: FormState },
  CreatingPasskey: {},
  PasskeyMade: { pubkey: PubkeyHex, form: FormState },
  PasskeyBackup: { pubkey: PubkeyHex, password: Password, confirmation: Password, form: FormState },
  FindingPasskey: {},
  PasskeyOtherKey: { pubkey: PubkeyHex, other: PubkeyHex, form: FormState },
  PasskeyLocked: { pubkey: PubkeyHex, form: FormState },
  Ready: { identity: SignerIdentity },
})
export type Step = typeof Step.Type

/** What stopped the last step: the signer's own failure, or a check of what the person typed. */
export const SetupProblem = Schema.Union([
  SignerFailure,
  Schema.Literals(['passwordTooShort', 'passwordsDiffer', 'backupNotSaved', 'backupMissing']),
])
export type SetupProblem = typeof SetupProblem.Type

/** Passkeys on this page: not offered (the stage offers none here, or the browser has no WebAuthn), offered, or found
 * unable to derive a key (no PRF), after which the in-browser key is offered instead. */
export const PasskeyOffer = Schema.Literals(['notOffered', 'offered', 'unsupported'])
export type PasskeyOffer = typeof PasskeyOffer.Type

export const Model = Schema.Struct({
  language: Language,
  /** Whether the browser has a NIP-07 extension, as last detected. */
  extension: Schema.Boolean,
  /** The WebAuthn relying party ID the stage makes passkeys for on this page; none, it offers none here. */
  maybePasskeyRpId: Schema.Option(Schema.String),
  passkey: PasskeyOffer,
  step: Step,
  maybeProblem: Schema.Option(SetupProblem),
})
export type Model = typeof Model.Type

/** The shortest password a new key's backup takes. It guards a key anyone holding the backup can try to open. */
export const minimumPassword = 8

// MESSAGE

export const Message = defineMessageUnion({
  CompletedDetectSigner: {
    extension: Schema.Boolean,
    passkeys: Schema.Boolean,
    maybeRemembered: Schema.Option(SignerIdentity),
    maybeUnlocked: Schema.Option(SignerIdentity),
  },
  ClickedUseExtension: {},
  SucceededConnectExtension: { identity: SignerIdentity },
  FailedConnectExtension: { reason: SignerFailure },
  ClickedCreateKey: {},
  ClickedRestoreKey: {},
  ClickedBack: {},
  UpdatedPassword: { value: Password },
  UpdatedConfirmation: { value: Password },
  UpdatedBackup: { value: Schema.String },
  SubmittedCreateKey: {},
  SucceededCreateKey: { pubkey: PubkeyHex, ncryptsec: Schema.String },
  FailedCreateKey: { reason: SignerFailure },
  UpdatedBackupSaved: { saved: Schema.Boolean },
  ClickedFinishBackup: {},
  SucceededConfirmBackup: { identity: SignerIdentity },
  FailedConfirmBackup: { reason: SignerFailure },
  ClickedCreatePasskey: {},
  SucceededCreatePasskey: { pubkey: PubkeyHex },
  FailedCreatePasskey: { reason: SignerFailure },
  ClickedBackUpPasskey: {},
  SubmittedPasskeyBackup: {},
  SucceededBackUpPasskey: { pubkey: PubkeyHex, ncryptsec: Schema.String },
  FailedBackUpPasskey: { reason: SignerFailure },
  ClickedSkipBackup: {},
  ClickedUsePasskey: {},
  SucceededFindPasskey: { pubkey: PubkeyHex, maybeOther: Schema.Option(PubkeyHex) },
  FailedFindPasskey: { reason: SignerFailure },
  ClickedUseFoundKey: {},
  SucceededKeepPasskey: { identity: SignerIdentity },
  FailedKeepPasskey: { reason: SignerFailure },
  CompletedDropCreated: {},
  ClickedUnlockPasskey: {},
  SubmittedRestoreKey: {},
  SucceededRestoreKey: { identity: SignerIdentity },
  FailedRestoreKey: { reason: SignerFailure },
  SubmittedUnlock: {},
  SucceededUnlock: { identity: SignerIdentity },
  FailedUnlock: { reason: SignerFailure },
  ClickedForget: {},
  CompletedForget: {},
})
export type Message = typeof Message.Type

/** The page learns when a signer is ready, and when the person dropped it. */
export const OutMessage = defineMessageUnion({
  SignerReady: { identity: SignerIdentity },
  SignerForgotten: {},
})
export type OutMessage = typeof OutMessage.Type

// COMMAND

export const DetectSigner = Command.define('DetectSigner', {
  messages: [Message.CompletedDetectSigner],
  execute: Effect.gen(function* () {
    const detected = yield* (yield* Signers).detect
    return Message.CompletedDetectSigner(detected)
  }),
})

export const ConnectExtension = Command.define('ConnectExtension', {
  messages: [Message.SucceededConnectExtension, Message.FailedConnectExtension],
  execute: Effect.gen(function* () {
    const identity = yield* (yield* Signers).connectExtension
    return Message.SucceededConnectExtension({ identity })
  }).pipe(Effect.catch((error) => Effect.succeed(Message.FailedConnectExtension({ reason: error.reason })))),
})

export const CreateKey = Command.define('CreateKey', {
  args: { password: Password },
  messages: [Message.SucceededCreateKey, Message.FailedCreateKey],
  execute: ({ password }) =>
    Effect.gen(function* () {
      const created = yield* (yield* Signers).createLocal(password)
      return Message.SucceededCreateKey(created)
    }).pipe(Effect.catch((error) => Effect.succeed(Message.FailedCreateKey({ reason: error.reason })))),
})

export const ConfirmBackup = Command.define('ConfirmBackup', {
  messages: [Message.SucceededConfirmBackup, Message.FailedConfirmBackup],
  execute: Effect.gen(function* () {
    const identity = yield* (yield* Signers).keepCreated
    return Message.SucceededConfirmBackup({ identity })
  }).pipe(Effect.catch((error) => Effect.succeed(Message.FailedConfirmBackup({ reason: error.reason })))),
})

export const RestoreKey = Command.define('RestoreKey', {
  args: { ncryptsec: Schema.String, password: Password },
  messages: [Message.SucceededRestoreKey, Message.FailedRestoreKey],
  execute: ({ ncryptsec, password }) =>
    Effect.gen(function* () {
      const identity = yield* (yield* Signers).restoreLocal(ncryptsec, password)
      return Message.SucceededRestoreKey({ identity })
    }).pipe(Effect.catch((error) => Effect.succeed(Message.FailedRestoreKey({ reason: error.reason })))),
})

export const UnlockKey = Command.define('UnlockKey', {
  args: { password: Password },
  messages: [Message.SucceededUnlock, Message.FailedUnlock],
  execute: ({ password }) =>
    Effect.gen(function* () {
      const identity = yield* (yield* Signers).unlockLocal(password)
      return Message.SucceededUnlock({ identity })
    }).pipe(Effect.catch((error) => Effect.succeed(Message.FailedUnlock({ reason: error.reason })))),
})

export const CreatePasskey = Command.define('CreatePasskey', {
  args: { rpId: Schema.String },
  messages: [Message.SucceededCreatePasskey, Message.FailedCreatePasskey],
  execute: ({ rpId }) =>
    Effect.gen(function* () {
      const pubkey = yield* (yield* Signers).createPasskey(rpId)
      return Message.SucceededCreatePasskey({ pubkey })
    }).pipe(Effect.catch((error) => Effect.succeed(Message.FailedCreatePasskey({ reason: error.reason })))),
})

export const BackUpPasskey = Command.define('BackUpPasskey', {
  args: { password: Password },
  messages: [Message.SucceededBackUpPasskey, Message.FailedBackUpPasskey],
  execute: ({ password }) =>
    Effect.gen(function* () {
      const backup = yield* (yield* Signers).backUpCreated(password)
      return Message.SucceededBackUpPasskey(backup)
    }).pipe(Effect.catch((error) => Effect.succeed(Message.FailedBackUpPasskey({ reason: error.reason })))),
})

export const FindPasskey = Command.define('FindPasskey', {
  args: { rpId: Schema.String },
  messages: [Message.SucceededFindPasskey, Message.FailedFindPasskey],
  execute: ({ rpId }) =>
    Effect.gen(function* () {
      const found = yield* (yield* Signers).findPasskey(rpId)
      return Message.SucceededFindPasskey(found)
    }).pipe(Effect.catch((error) => Effect.succeed(Message.FailedFindPasskey({ reason: error.reason })))),
})

export const KeepPasskey = Command.define('KeepPasskey', {
  messages: [Message.SucceededKeepPasskey, Message.FailedKeepPasskey],
  execute: Effect.gen(function* () {
    const identity = yield* (yield* Signers).keepCreated
    return Message.SucceededKeepPasskey({ identity })
  }).pipe(Effect.catch((error) => Effect.succeed(Message.FailedKeepPasskey({ reason: error.reason })))),
})

export const DropCreated = Command.define('DropCreated', {
  messages: [Message.CompletedDropCreated],
  execute: Effect.gen(function* () {
    yield* (yield* Signers).dropCreated
    return Message.CompletedDropCreated()
  }),
})

export const UnlockPasskey = Command.define('UnlockPasskey', {
  args: { rpId: Schema.String },
  messages: [Message.SucceededUnlock, Message.FailedUnlock],
  execute: ({ rpId }) =>
    Effect.gen(function* () {
      const identity = yield* (yield* Signers).unlockPasskey(rpId)
      return Message.SucceededUnlock({ identity })
    }).pipe(Effect.catch((error) => Effect.succeed(Message.FailedUnlock({ reason: error.reason })))),
})

export const ForgetSigner = Command.define('ForgetSigner', {
  messages: [Message.CompletedForget],
  execute: Effect.gen(function* () {
    yield* (yield* Signers).forget
    return Message.CompletedForget()
  }),
})

// INIT

type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, OutMessage, Signers>

/** Nothing is known until the browser looks: the server renders the same `Detecting`, and hydration then looks. */
export const init = (language: Language, maybePasskeyRpId: Option.Option<string> = Option.none()): UpdateReturn => ({
  model: {
    language,
    extension: false,
    maybePasskeyRpId,
    passkey: 'notOffered',
    step: Step.Detecting(),
    maybeProblem: Option.none(),
  },
  commands: [DetectSigner()],
})

/** The relying party ID passkeys are made and found for, while they are offered. */
export const offeredRpId = (model: Model): Option.Option<string> =>
  model.passkey === 'offered' ? model.maybePasskeyRpId : Option.none()

// UPDATE

const empty = Redacted.make('')

const withStep = (model: Model, step: Step): Model =>
  modifyFields(model, { step: () => step, maybeProblem: () => Option.none() })

const refused = (model: Model, step: Step, problem: SetupProblem): UpdateReturn => ({
  model: modifyFields(model, { step: () => step, maybeProblem: () => Option.some(problem) }),
})

const ready = (model: Model, identity: SignerIdentity): UpdateReturn => ({
  model: withStep(model, Step.Ready({ identity })),
  outMessage: OutMessage.SignerReady({ identity }),
})

/** The step a remembered signer waits in: a local key for its password, a passkey key for its passkey; an extension
 * is offered again from the choice. */
const lockedStep = (identity: SignerIdentity): Step =>
  identity.signerKind === 'local'
    ? Step.Locked({ pubkey: identity.pubkey, password: empty, form: 'editing' })
    : identity.signerKind === 'passkey'
      ? Step.PasskeyLocked({ pubkey: identity.pubkey, form: 'editing' })
      : Step.Choosing()

const detected = (
  model: Model,
  found: {
    readonly extension: boolean
    readonly passkeys: boolean
    readonly maybeRemembered: Option.Option<SignerIdentity>
  },
  maybeUnlocked: Option.Option<SignerIdentity>,
): UpdateReturn => {
  const passkey: PasskeyOffer = found.passkeys && Option.isSome(model.maybePasskeyRpId) ? 'offered' : 'notOffered'
  const withBrowser = modifyFields(model, { extension: () => found.extension, passkey: () => passkey })
  return Option.match(maybeUnlocked, {
    onSome: (identity) => ready(withBrowser, identity),
    onNone: () => ({
      model: withStep(withBrowser, Option.match(found.maybeRemembered, { onNone: Step.Choosing, onSome: lockedStep })),
    }),
  })
}

/** The new key's password, if it is long enough and typed the same twice. */
const passwordProblem = (password: Password, confirmation: Password): Option.Option<SetupProblem> => {
  const typed = Redacted.value(password)
  if (typed.length < minimumPassword) {
    return Option.some('passwordTooShort')
  }
  return typed === Redacted.value(confirmation) ? Option.none() : Option.some('passwordsDiffer')
}

/** Updates the step the person is on, if it is one of the steps a message is for. */
const onStep = (model: Model, next: (step: Step) => Option.Option<UpdateReturn>): UpdateReturn =>
  Option.getOrElse(next(model.step), () => ({ model }))

const typedPassword = (model: Model, value: Password): UpdateReturn =>
  onStep(model, (step) =>
    Step.guards.Creating(step) || Step.guards.PasskeyBackup(step)
      ? Option.some({ model: withStep(model, modifyFields(step, { password: () => value })) })
      : Step.guards.Restoring(step)
        ? Option.some({ model: withStep(model, modifyFields(step, { password: () => value })) })
        : Step.guards.Locked(step)
          ? Option.some({ model: withStep(model, modifyFields(step, { password: () => value })) })
          : Option.none(),
  )

const typedConfirmation = (model: Model, value: Password): UpdateReturn =>
  onStep(model, (step) =>
    Step.guards.Creating(step) || Step.guards.PasskeyBackup(step)
      ? Option.some({ model: withStep(model, modifyFields(step, { confirmation: () => value })) })
      : Option.none(),
  )

const submittedCreate = (model: Model): UpdateReturn =>
  onStep(model, (step) =>
    Step.guards.Creating(step) && step.form === 'editing'
      ? Option.some(
          Option.match(passwordProblem(step.password, step.confirmation), {
            onSome: (problem) => refused(model, step, problem),
            onNone: () => ({
              model: withStep(model, modifyFields(step, { form: () => 'working' })),
              commands: [CreateKey({ password: step.password })],
            }),
          }),
        )
      : Option.none(),
  )

const submittedPasskeyBackup = (model: Model): UpdateReturn =>
  onStep(model, (step) =>
    Step.guards.PasskeyBackup(step) && step.form === 'editing'
      ? Option.some(
          Option.match(passwordProblem(step.password, step.confirmation), {
            onSome: (problem) => refused(model, step, problem),
            onNone: () => ({
              model: withStep(model, modifyFields(step, { form: () => 'working' })),
              commands: [BackUpPasskey({ password: step.password })],
            }),
          }),
        )
      : Option.none(),
  )

const submittedRestore = (model: Model): UpdateReturn =>
  onStep(model, (step) =>
    Step.guards.Restoring(step) && step.form === 'editing'
      ? Option.some(
          step.ncryptsec.trim() === ''
            ? refused(model, step, 'backupMissing')
            : {
                model: withStep(model, modifyFields(step, { form: () => 'working' })),
                commands: [RestoreKey({ ncryptsec: step.ncryptsec, password: step.password })],
              },
        )
      : Option.none(),
  )

const submittedUnlock = (model: Model): UpdateReturn =>
  onStep(model, (step) =>
    Step.guards.Locked(step) && step.form === 'editing'
      ? Option.some({
          model: withStep(model, modifyFields(step, { form: () => 'working' })),
          commands: [UnlockKey({ password: step.password })],
        })
      : Option.none(),
  )

const clickedUnlockPasskey = (model: Model): UpdateReturn =>
  onStep(model, (step) =>
    Step.guards.PasskeyLocked(step) && step.form === 'editing'
      ? Option.some(
          Option.match(model.maybePasskeyRpId, {
            onNone: () => refused(model, step, 'passkeyUnavailable'),
            onSome: (rpId) => ({
              model: withStep(model, modifyFields(step, { form: () => 'working' })),
              commands: [UnlockPasskey({ rpId })],
            }),
          }),
        )
      : Option.none(),
  )

/** Keeps the passkey key just made or found, from the step that offered it. */
const keepingPasskey = (model: Model): UpdateReturn =>
  onStep(model, (step) =>
    (Step.guards.PasskeyMade(step) || Step.guards.PasskeyOtherKey(step)) && step.form === 'editing'
      ? Option.some({
          model: withStep(model, modifyFields(step, { form: () => 'working' })),
          commands: [KeepPasskey()],
        })
      : Option.none(),
  )

/** A passkey found: kept at once, unless this browser remembers another key, which the person then chooses between. */
const foundPasskey = (model: Model, pubkey: PubkeyHex, maybeOther: Option.Option<PubkeyHex>): UpdateReturn =>
  Option.match(maybeOther, {
    onNone: () => ({ model: withStep(model, Step.FindingPasskey()), commands: [KeepPasskey()] }),
    onSome: (other) => ({ model: withStep(model, Step.PasskeyOtherKey({ pubkey, other, form: 'editing' })) }),
  })

/** A failed piece of work: the form is back to editing, without the password that did not work, and says why. */
const failedStep = (model: Model, reason: SignerFailure): UpdateReturn =>
  Step.match(model.step, {
    Detecting: () => refused(model, Step.Choosing(), reason),
    Choosing: () => refused(model, Step.Choosing(), reason),
    ConnectingExtension: () => refused(model, Step.Choosing(), reason),
    Creating: (step) => refused(model, modifyFields(step, { form: () => 'editing' }), reason),
    BackingUp: (step) => refused(model, step, reason),
    Restoring: (step) => refused(model, modifyFields(step, { password: () => empty, form: () => 'editing' }), reason),
    Locked: (step) => refused(model, modifyFields(step, { password: () => empty, form: () => 'editing' }), reason),
    CreatingPasskey: () => refused(model, Step.Choosing(), reason),
    PasskeyMade: (step) => refused(model, modifyFields(step, { form: () => 'editing' }), reason),
    PasskeyBackup: (step) =>
      refused(
        model,
        modifyFields(step, { password: () => empty, confirmation: () => empty, form: () => 'editing' }),
        reason,
      ),
    FindingPasskey: () => refused(model, Step.Choosing(), reason),
    PasskeyOtherKey: (step) => refused(model, modifyFields(step, { form: () => 'editing' }), reason),
    PasskeyLocked: (step) => refused(model, modifyFields(step, { form: () => 'editing' }), reason),
    Ready: (step) => refused(model, step, reason),
  })

/** A failure says why; one that found passkeys unable to derive a key also stops offering them on this page, so the
 * in-browser key is the offer. */
const failedWork = (model: Model, reason: SignerFailure): UpdateReturn =>
  failedStep(reason === 'passkeyNoPrf' ? modifyFields(model, { passkey: () => 'unsupported' }) : model, reason)

const finishedBackup = (model: Model): UpdateReturn =>
  onStep(model, (step) =>
    Step.guards.BackingUp(step)
      ? Option.some(
          step.saved
            ? { model: withStep(model, step), commands: [ConfirmBackup()] }
            : refused(model, step, 'backupNotSaved'),
        )
      : Option.none(),
  )

/** Back: from the backup's password to the backup choice, else to the signer choice; a passkey key found but not
 * chosen is dropped. */
const back = (model: Model): UpdateReturn =>
  Step.guards.PasskeyBackup(model.step)
    ? { model: withStep(model, Step.PasskeyMade({ pubkey: model.step.pubkey, form: 'editing' })) }
    : Step.guards.PasskeyOtherKey(model.step)
      ? { model: withStep(model, Step.Choosing()), commands: [DropCreated()] }
      : { model: withStep(model, Step.Choosing()) }

/** One handler per Message, as `Message.match` takes them; the two halves below each give some. */
type Handlers = {
  readonly [Tag in Message['_tag']]: (message: Extract<Message, { readonly _tag: Tag }>) => UpdateReturn
}

/** The local key's and the extension's messages. */
const keyHandlers = (model: Model) =>
  ({
    CompletedDetectSigner: ({ extension, passkeys, maybeRemembered, maybeUnlocked }) =>
      detected(model, { extension, passkeys, maybeRemembered }, maybeUnlocked),
    ClickedUseExtension: () => ({ model: withStep(model, Step.ConnectingExtension()), commands: [ConnectExtension()] }),
    SucceededConnectExtension: ({ identity }) => ready(model, identity),
    FailedConnectExtension: ({ reason }) => failedWork(model, reason),
    ClickedCreateKey: () => ({
      model: withStep(model, Step.Creating({ password: empty, confirmation: empty, form: 'editing' })),
    }),
    ClickedRestoreKey: () => ({
      model: withStep(model, Step.Restoring({ ncryptsec: '', password: empty, form: 'editing' })),
    }),
    ClickedBack: () => back(model),
    UpdatedPassword: ({ value }) => typedPassword(model, value),
    UpdatedConfirmation: ({ value }) => typedConfirmation(model, value),
    UpdatedBackup: ({ value }) =>
      onStep(model, (step) =>
        Step.guards.Restoring(step)
          ? Option.some({ model: withStep(model, modifyFields(step, { ncryptsec: () => value })) })
          : Option.none(),
      ),
    SubmittedCreateKey: () => submittedCreate(model),
    SucceededCreateKey: ({ pubkey, ncryptsec }) => ({
      model: withStep(model, Step.BackingUp({ pubkey, ncryptsec, saved: false })),
    }),
    FailedCreateKey: ({ reason }) => failedWork(model, reason),
    UpdatedBackupSaved: ({ saved }) =>
      onStep(model, (step) =>
        Step.guards.BackingUp(step)
          ? Option.some({ model: withStep(model, modifyFields(step, { saved: () => saved })) })
          : Option.none(),
      ),
    ClickedFinishBackup: () => finishedBackup(model),
    SucceededConfirmBackup: ({ identity }) => ready(model, identity),
    FailedConfirmBackup: ({ reason }) => failedWork(model, reason),
    SubmittedRestoreKey: () => submittedRestore(model),
    SucceededRestoreKey: ({ identity }) => ready(model, identity),
    FailedRestoreKey: ({ reason }) => failedWork(model, reason),
    SubmittedUnlock: () => submittedUnlock(model),
    SucceededUnlock: ({ identity }) => ready(model, identity),
    FailedUnlock: ({ reason }) => failedWork(model, reason),
    ClickedForget: () => ({ model, commands: [ForgetSigner()] }),
    CompletedForget: () => ({
      model: withStep(model, Step.Choosing()),
      outMessage: OutMessage.SignerForgotten(),
    }),
  }) satisfies Partial<Handlers>

/** The passkey key's messages. */
const passkeyHandlers = (model: Model) =>
  ({
    ClickedCreatePasskey: () =>
      Option.match(offeredRpId(model), {
        onNone: () => ({ model }),
        onSome: (rpId) => ({ model: withStep(model, Step.CreatingPasskey()), commands: [CreatePasskey({ rpId })] }),
      }),
    SucceededCreatePasskey: ({ pubkey }) => ({ model: withStep(model, Step.PasskeyMade({ pubkey, form: 'editing' })) }),
    FailedCreatePasskey: ({ reason }) => failedWork(model, reason),
    ClickedBackUpPasskey: () =>
      onStep(model, (step) =>
        Step.guards.PasskeyMade(step)
          ? Option.some({
              model: withStep(
                model,
                Step.PasskeyBackup({ pubkey: step.pubkey, password: empty, confirmation: empty, form: 'editing' }),
              ),
            })
          : Option.none(),
      ),
    SubmittedPasskeyBackup: () => submittedPasskeyBackup(model),
    SucceededBackUpPasskey: ({ pubkey, ncryptsec }) => ({
      model: withStep(model, Step.BackingUp({ pubkey, ncryptsec, saved: false })),
    }),
    FailedBackUpPasskey: ({ reason }) => failedWork(model, reason),
    ClickedSkipBackup: () => keepingPasskey(model),
    ClickedUsePasskey: () =>
      Option.match(offeredRpId(model), {
        onNone: () => ({ model }),
        onSome: (rpId) => ({ model: withStep(model, Step.FindingPasskey()), commands: [FindPasskey({ rpId })] }),
      }),
    SucceededFindPasskey: ({ pubkey, maybeOther }) => foundPasskey(model, pubkey, maybeOther),
    FailedFindPasskey: ({ reason }) => failedWork(model, reason),
    ClickedUseFoundKey: () => keepingPasskey(model),
    SucceededKeepPasskey: ({ identity }) => ready(model, identity),
    FailedKeepPasskey: ({ reason }) => failedWork(model, reason),
    CompletedDropCreated: () => ({ model }),
    ClickedUnlockPasskey: () => clickedUnlockPasskey(model),
  }) satisfies Partial<Handlers>

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, { ...keyHandlers(model), ...passkeyHandlers(model) })
