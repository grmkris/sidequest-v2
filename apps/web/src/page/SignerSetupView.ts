import { Option, Redacted } from 'effect'
import { type Html, Submodel } from 'foldkit'
import type { Language } from '../Language.ts'
import type { Password, SignerIdentity } from '../Signer.ts'
import { styled } from '../Styled.ts'
import { type PlainKey, say, shortHex } from '../Text.ts'
import * as Ui from '../Ui.ts'
import * as s from '../Ui.styles.ts'
import { Message, minimumPassword, type Model, type SetupProblem, Step } from './SignerSetup.ts'
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

const choosing = (h: Html.HtmlBuilder<Message>, model: Model) => {
  const language = model.language
  return [
    h.p([], [say(language, model.extension ? 'signer.choose.withExtension' : 'signer.choose.withoutExtension')]),
    h.div(styled(h, s.actions()), [
      model.extension
        ? Ui.button(h, {
            label: say(language, 'signer.useExtension'),
            onClick: Message.ClickedUseExtension(),
            kind: 'primary',
          })
        : h.empty,
      Ui.button(h, {
        label: say(language, 'signer.createKey'),
        onClick: Message.ClickedCreateKey(),
        kind: model.extension ? 'secondary' : 'primary',
      }),
      Ui.button(h, { label: say(language, 'signer.restoreKey'), onClick: Message.ClickedRestoreKey() }),
    ]),
  ]
}

const creating = (
  h: Html.HtmlBuilder<Message>,
  language: Language,
  step: Extract<Step, { readonly _tag: 'Creating' }>,
) => [
  h.form(
    [h.OnSubmit(Message.SubmittedCreateKey()), h.Novalidate(true), ...styled(h, s.form())],
    [
      h.p([], [say(language, 'signer.create.lede')]),
      passwordField(h, {
        id: 'signer-new-password',
        label: say(language, 'signer.create.password'),
        value: step.password,
        onInput: (value) => Message.UpdatedPassword({ value: Redacted.make(value) }),
        autocomplete: 'new-password',
        hint: format(language, 'signer.create.passwordHint', { minimum: minimumPassword }),
      }),
      passwordField(h, {
        id: 'signer-confirm-password',
        label: say(language, 'signer.create.confirmation'),
        value: step.confirmation,
        onInput: (value) => Message.UpdatedConfirmation({ value: Redacted.make(value) }),
        autocomplete: 'new-password',
      }),
      h.div(styled(h, s.actions()), [
        Ui.submit(h, {
          label: say(language, step.form === 'working' ? 'signer.create.working' : 'signer.create.submit'),
          busy: step.form === 'working',
        }),
        backButton(h, language),
      ]),
    ],
  ),
]

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
