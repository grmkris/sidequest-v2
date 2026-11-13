import { Effect, Option, Redacted, Schema } from 'effect'
import { Command, type Update } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'
import { Language } from '../Language.ts'
import { Password, PubkeyHex, SignerFailure, SignerIdentity, Signers } from '../Signer.ts'

// Choosing a Nostr signer: the browser's extension when it has one, else a key made here (with a backup the person
// must confirm they saved) or restored from a backup; after a reload, a local key unlocks with its password.

// MODEL

/** A form being filled in, or its work running (scrypt takes a second or more). */
const FormState = Schema.Literals(['editing', 'working'])

/** Where the person is in choosing a signer. `Choosing` is "no signer"; `Locked` is a local key kept in this browser,
 * waiting for its password; `Ready` signs. */
export const Step = defineTaggedUnion({
  Detecting: {},
  Choosing: {},
  ConnectingExtension: {},
  Creating: { password: Password, confirmation: Password, form: FormState },
  BackingUp: { pubkey: PubkeyHex, ncryptsec: Schema.String, saved: Schema.Boolean },
  Restoring: { ncryptsec: Schema.String, password: Password, form: FormState },
  Locked: { pubkey: PubkeyHex, password: Password, form: FormState },
  Ready: { identity: SignerIdentity },
})
export type Step = typeof Step.Type

/** What stopped the last step: the signer's own failure, or a check of what the person typed. */
export const SetupProblem = Schema.Union([
  SignerFailure,
  Schema.Literals(['passwordTooShort', 'passwordsDiffer', 'backupNotSaved', 'backupMissing']),
])
export type SetupProblem = typeof SetupProblem.Type

export const Model = Schema.Struct({
  language: Language,
  /** Whether the browser has a NIP-07 extension, as last detected. */
  extension: Schema.Boolean,
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
    const identity = yield* (yield* Signers).confirmBackup
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
export const init = (language: Language): UpdateReturn => ({
  model: { language, extension: false, step: Step.Detecting(), maybeProblem: Option.none() },
  commands: [DetectSigner()],
})

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

const detected = (
  model: Model,
  found: { readonly extension: boolean; readonly maybeRemembered: Option.Option<SignerIdentity> },
  maybeUnlocked: Option.Option<SignerIdentity>,
): UpdateReturn => {
  const withExtension = modifyFields(model, { extension: () => found.extension })
  return Option.match(maybeUnlocked, {
    onSome: (identity) => ready(withExtension, identity),
    onNone: () =>
      Option.match(
        Option.filter(found.maybeRemembered, (identity) => identity.signerKind === 'local'),
        {
          onSome: ({ pubkey }) => ({
            model: withStep(withExtension, Step.Locked({ pubkey, password: empty, form: 'editing' })),
          }),
          onNone: () => ({ model: withStep(withExtension, Step.Choosing()) }),
        },
      ),
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
    Step.guards.Creating(step)
      ? Option.some({ model: withStep(model, modifyFields(step, { password: () => value })) })
      : Step.guards.Restoring(step)
        ? Option.some({ model: withStep(model, modifyFields(step, { password: () => value })) })
        : Step.guards.Locked(step)
          ? Option.some({ model: withStep(model, modifyFields(step, { password: () => value })) })
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

/** A failed piece of work: the form is back to editing, without the password that did not work, and says why. */
const failedWork = (model: Model, reason: SignerFailure): UpdateReturn =>
  Step.match(model.step, {
    Detecting: () => refused(model, Step.Choosing(), reason),
    Choosing: () => refused(model, Step.Choosing(), reason),
    ConnectingExtension: () => refused(model, Step.Choosing(), reason),
    Creating: (step) => refused(model, modifyFields(step, { form: () => 'editing' }), reason),
    BackingUp: (step) => refused(model, step, reason),
    Restoring: (step) => refused(model, modifyFields(step, { password: () => empty, form: () => 'editing' }), reason),
    Locked: (step) => refused(model, modifyFields(step, { password: () => empty, form: () => 'editing' }), reason),
    Ready: (step) => refused(model, step, reason),
  })

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

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    CompletedDetectSigner: ({ extension, maybeRemembered, maybeUnlocked }) =>
      detected(model, { extension, maybeRemembered }, maybeUnlocked),
    ClickedUseExtension: () => ({ model: withStep(model, Step.ConnectingExtension()), commands: [ConnectExtension()] }),
    SucceededConnectExtension: ({ identity }) => ready(model, identity),
    FailedConnectExtension: ({ reason }) => failedWork(model, reason),
    ClickedCreateKey: () => ({
      model: withStep(model, Step.Creating({ password: empty, confirmation: empty, form: 'editing' })),
    }),
    ClickedRestoreKey: () => ({
      model: withStep(model, Step.Restoring({ ncryptsec: '', password: empty, form: 'editing' })),
    }),
    ClickedBack: () => ({ model: withStep(model, Step.Choosing()) }),
    UpdatedPassword: ({ value }) => typedPassword(model, value),
    UpdatedConfirmation: ({ value }) =>
      onStep(model, (step) =>
        Step.guards.Creating(step)
          ? Option.some({ model: withStep(model, modifyFields(step, { confirmation: () => value })) })
          : Option.none(),
      ),
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
  })
