import { Option, Redacted } from 'effect'
import { type Html, Submodel } from 'foldkit'
import type { Language } from '../Language.ts'
import type { Password, SignerIdentity } from '../Signer.ts'
import { styled } from '../Styled.ts'
import { type PlainKey, say, shortHex } from '../Text.ts'
import * as Ui from '../Ui.ts'
import * as s from '../Ui.styles.ts'
import * as PasskeyView from './SignerSetupPasskeyView.ts'
import { Message, minimumPassword, type Model, offeredRpId, type SetupProblem, Step } from './SignerSetup.ts'
import { format } from '@sidequest/i18n'

const problemKeys: Readonly<Record<Exclude<SetupProblem, 'passwordTooShort'>, PlainKey>> = {
  noExtension: 'signer.problem.noExtension',
  extensionRefused: 'signer.problem.extensionRefused',
  extensionUntrusted: 'signer.problem.extensionUntrusted',
  locked: 'signer.problem.locked',
  wrongPassword: 'signer.problem.wrongPassword',
  notABackup: 'signer.problem.notABackup',
  nothingStored: 'signer.problem.nothingStored',
  notLoaded: 'signer.problem.notLoaded',
  passkeyUnavailable: 'signer.problem.passkeyUnavailable',
  passkeyNoPrf: 'signer.problem.passkeyNoPrf',
  passkeyCancelled: 'signer.problem.passkeyCancelled',
  passkeyFailed: 'signer.problem.passkeyFailed',
  passkeyOtherKey: 'signer.problem.passkeyOtherKey',
  passwordsDiffer: 'signer.problem.passwordsDiffer',
  backupNotSaved: 'signer.problem.backupNotSaved',
  backupMissing: 'signer.problem.backupMissing',
}

/** Why the last step did not go through, in one sentence. */
export const setupProblemText = (language: Language, problem: SetupProblem): string =>
  problem === 'passwordTooShort'
    ? format(language, 'signer.problem.passwordTooShort', { minimum: minimumPassword })
    : say(language, problemKeys[problem])

const problemView = (h: Html.HtmlBuilder<Message>, model: Model) =>
  Option.match(model.maybeProblem, {
    onNone: () => h.empty,
    onSome: (problem) => Ui.notice(h, 'danger', [h.p([], [setupProblemText(model.language, problem)])]),
  })

const passwordField = (
  h: Html.HtmlBuilder<Message>,
  config: {
    readonly id: string
    readonly label: string
    readonly value: Password
    readonly onInput: (value: string) => Message
    readonly autocomplete: string
    readonly hint?: string
  },
) =>
  Ui.textField(h, {
    id: config.id,
    label: config.label,
    value: Redacted.value(config.value),
    onInput: config.onInput,
    type: 'password',
    autocomplete: config.autocomplete,
    required: true,
    ...(config.hint === undefined ? {} : { hint: config.hint }),
  })

const backButton = (h: Html.HtmlBuilder<Message>, language: Language) =>
  Ui.linkButton(h, say(language, 'signer.back'), Message.ClickedBack())

type Offer = 'extension' | 'passkey' | 'local'

/** The signers to offer, first the one ADR-0003 prefers: the extension, else a passkey, else a key made here. */
const offers = (model: Model): ReadonlyArray<Offer> => {
  const passkey = Option.isSome(offeredRpId(model))
  return model.extension
    ? passkey
      ? ['extension', 'passkey', 'local']
      : ['extension', 'local']
    : passkey
      ? ['passkey', 'local']
      : ['local']
}

const offerButton = (h: Html.HtmlBuilder<Message>, language: Language, offer: Offer, first: boolean) => {
  const kind = first ? 'primary' : 'secondary'
  return offer === 'extension'
    ? Ui.button(h, { label: say(language, 'signer.useExtension'), onClick: Message.ClickedUseExtension(), kind })
    : offer === 'passkey'
      ? Ui.button(h, { label: say(language, 'signer.createPasskey'), onClick: Message.ClickedCreatePasskey(), kind })
      : Ui.button(h, { label: say(language, 'signer.createKey'), onClick: Message.ClickedCreateKey(), kind })
}

const chooseLede = (model: Model): PlainKey =>
  model.extension
    ? 'signer.choose.withExtension'
    : Option.isSome(offeredRpId(model))
      ? 'signer.choose.withPasskey'
      : 'signer.choose.withoutExtension'

const choosing = (h: Html.HtmlBuilder<Message>, model: Model) => {
  const language = model.language
  return [
    h.p([], [say(language, chooseLede(model))]),
    h.div(styled(h, s.actions()), [
      ...offers(model).map((offer, index) => offerButton(h, language, offer, index === 0)),
      Option.isSome(offeredRpId(model))
        ? Ui.button(h, { label: say(language, 'signer.usePasskey'), onClick: Message.ClickedUsePasskey() })
        : h.empty,
      Ui.button(h, { label: say(language, 'signer.restoreKey'), onClick: Message.ClickedRestoreKey() }),
    ]),
  ]
}

/** A new password, typed twice: a new key's, or the backup's of a passkey key. */
const newPasswordForm = (
  h: Html.HtmlBuilder<Message>,
  language: Language,
  config: {
    readonly step: {
      readonly password: Password
      readonly confirmation: Password
      readonly form: 'editing' | 'working'
    }
    readonly onSubmit: Message
    readonly lede: PlainKey
    readonly submit: PlainKey
    readonly working: PlainKey
  },
) => [
  h.form(
    [h.OnSubmit(config.onSubmit), h.Novalidate(true), ...styled(h, s.form())],
    [
      h.p([], [say(language, config.lede)]),
      passwordField(h, {
        id: 'signer-new-password',
        label: say(language, 'signer.create.password'),
        value: config.step.password,
        onInput: (value) => Message.UpdatedPassword({ value: Redacted.make(value) }),
        autocomplete: 'new-password',
        hint: format(language, 'signer.create.passwordHint', { minimum: minimumPassword }),
      }),
      passwordField(h, {
        id: 'signer-confirm-password',
        label: say(language, 'signer.create.confirmation'),
        value: config.step.confirmation,
        onInput: (value) => Message.UpdatedConfirmation({ value: Redacted.make(value) }),
        autocomplete: 'new-password',
      }),
      h.div(styled(h, s.actions()), [
        Ui.submit(h, {
          label: say(language, config.step.form === 'working' ? config.working : config.submit),
          busy: config.step.form === 'working',
        }),
        backButton(h, language),
      ]),
    ],
  ),
]

const creating = (
  h: Html.HtmlBuilder<Message>,
  language: Language,
  step: Extract<Step, { readonly _tag: 'Creating' }>,
) =>
  newPasswordForm(h, language, {
    step,
    onSubmit: Message.SubmittedCreateKey(),
    lede: 'signer.create.lede',
    submit: 'signer.create.submit',
    working: 'signer.create.working',
  })

/** The backup as a file to keep: a data URL, which the edge's CSP lets a download link use. */
const backupHref = (ncryptsec: string) => `data:text/plain;charset=utf-8,${encodeURIComponent(`${ncryptsec}\n`)}`

const backingUp = (
  h: Html.HtmlBuilder<Message>,
  language: Language,
  step: Extract<Step, { readonly _tag: 'BackingUp' }>,
) => [
  Ui.notice(h, 'neutral', [
    h.p([], [say(language, 'signer.backup.lede')]),
    h.p([], [say(language, 'signer.backup.warning')]),
  ]),
  Ui.facts(h, [
    Ui.fact(h, say(language, 'signer.key'), Ui.dataText(h, shortHex(step.pubkey))),
    Ui.fact(
      h,
      say(language, 'signer.backup.label'),
      h.code([h.Id('signer-backup'), ...styled(h, s.data())], [step.ncryptsec]),
    ),
  ]),
  h.div(styled(h, s.actions()), [
    h.a(
      [h.Href(backupHref(step.ncryptsec)), h.Download('sidequest-nostr-key.txt'), ...styled(h, s.linkButton())],
      [say(language, 'signer.backup.download')],
    ),
  ]),
  h.label(styled(h, s.choice()), [
    h.input([
      h.Type('checkbox'),
      h.Checked(step.saved),
      h.OnChange(() => Message.UpdatedBackupSaved({ saved: !step.saved })),
    ]),
    say(language, 'signer.backup.saved'),
  ]),
  h.div(styled(h, s.actions()), [
    Ui.button(h, {
      label: say(language, 'signer.backup.continue'),
      onClick: Message.ClickedFinishBackup(),
      kind: 'primary',
    }),
  ]),
]

/** The password that opens a key, and the button that opens it, which says so while scrypt runs. */
const openingFields = (
  h: Html.HtmlBuilder<Message>,
  language: Language,
  config: {
    readonly id: string
    readonly step: { readonly password: Password; readonly form: 'editing' | 'working' }
    readonly submit: string
    readonly aside: Html.Html
  },
) => [
  passwordField(h, {
    id: config.id,
    label: say(language, 'signer.password'),
    value: config.step.password,
    onInput: (value) => Message.UpdatedPassword({ value: Redacted.make(value) }),
    autocomplete: 'current-password',
  }),
  h.div(styled(h, s.actions()), [
    Ui.submit(h, {
      label: config.step.form === 'working' ? say(language, 'signer.opening') : config.submit,
      busy: config.step.form === 'working',
    }),
    config.aside,
  ]),
]

const restoring = (
  h: Html.HtmlBuilder<Message>,
  language: Language,
  step: Extract<Step, { readonly _tag: 'Restoring' }>,
) => [
  h.form(
    [h.OnSubmit(Message.SubmittedRestoreKey()), h.Novalidate(true), ...styled(h, s.form())],
    [
      Ui.textArea(h, {
        id: 'signer-backup-input',
        label: say(language, 'signer.restore.backup'),
        hint: say(language, 'signer.restore.backupHint'),
        value: step.ncryptsec,
        onInput: (value) => Message.UpdatedBackup({ value }),
        required: true,
      }),
      ...openingFields(h, language, {
        id: 'signer-restore-password',
        step,
        submit: say(language, 'signer.restore.submit'),
        aside: backButton(h, language),
      }),
    ],
  ),
]

const locked = (h: Html.HtmlBuilder<Message>, language: Language, step: Extract<Step, { readonly _tag: 'Locked' }>) => [
  h.p([], [say(language, 'signer.unlock.lede')]),
  Ui.facts(h, [Ui.fact(h, say(language, 'signer.key'), Ui.dataText(h, shortHex(step.pubkey)))]),
  h.form(
    [h.OnSubmit(Message.SubmittedUnlock()), h.Novalidate(true), ...styled(h, s.form())],
    [
      ...openingFields(h, language, {
        id: 'signer-unlock-password',
        step,
        submit: say(language, 'signer.unlock.submit'),
        aside: Ui.linkButton(h, say(language, 'signer.forget'), Message.ClickedForget()),
      }),
    ],
  ),
]

const kindKeys: Readonly<Record<SignerIdentity['signerKind'], PlainKey>> = {
  nip07: 'signer.kind.nip07',
  local: 'signer.kind.local',
  passkey: 'signer.kind.passkey',
}

const readyView = (h: Html.HtmlBuilder<Message>, language: Language, identity: SignerIdentity) => [
  Ui.facts(h, [
    Ui.fact(h, say(language, 'signer.signer'), say(language, kindKeys[identity.signerKind])),
    Ui.fact(h, say(language, 'signer.key'), Ui.dataText(h, identity.pubkey)),
  ]),
  h.div(styled(h, s.actions()), [Ui.linkButton(h, say(language, 'signer.forget'), Message.ClickedForget())]),
]

const stepView = (h: Html.HtmlBuilder<Message>, model: Model): ReadonlyArray<Html.Html> => {
  const language = model.language
  return Step.match(model.step, {
    Detecting: () => [Ui.waiting(h, say(language, 'signer.detecting'))],
    Choosing: () => choosing(h, model),
    ConnectingExtension: () => [
      Ui.button(h, {
        label: say(language, 'signer.connecting'),
        onClick: Message.ClickedUseExtension(),
        kind: 'primary',
        busy: true,
      }),
    ],
    Creating: (step) => creating(h, language, step),
    BackingUp: (step) => backingUp(h, language, step),
    Restoring: (step) => restoring(h, language, step),
    Locked: (step) => locked(h, language, step),
    CreatingPasskey: () => [Ui.waiting(h, say(language, 'signer.passkey.creating'))],
    PasskeyMade: (step) => PasskeyView.made(h, language, step),
    PasskeyBackup: (step) =>
      newPasswordForm(h, language, {
        step,
        onSubmit: Message.SubmittedPasskeyBackup(),
        lede: 'signer.passkey.backupLede',
        submit: 'signer.passkey.backupSubmit',
        working: 'signer.passkey.backupWorking',
      }),
    FindingPasskey: () => [Ui.waiting(h, say(language, 'signer.passkey.finding'))],
    PasskeyOtherKey: (step) => PasskeyView.otherKey(h, language, step),
    PasskeyLocked: (step) => PasskeyView.locked(h, language, step, Option.isSome(model.maybePasskeyRpId)),
    Ready: ({ identity }) => readyView(h, language, identity),
  })
}

/** Choosing, making, restoring or unlocking the person's Nostr signer. */
export const view = Submodel.defineView<Model, Message>((model, h) =>
  h.section(
    [h.AriaLabelledBy('signer-title'), ...styled(h, s.panel())],
    [h.h2([h.Id('signer-title')], [say(model.language, 'signer.title')]), ...stepView(h, model), problemView(h, model)],
  ),
)
