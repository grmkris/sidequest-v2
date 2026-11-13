import type { Html } from 'foldkit'
import type { Language } from '../Language.ts'
import { styled } from '../Styled.ts'
import { say, shortHex } from '../Text.ts'
import * as Ui from '../Ui.ts'
import * as s from '../Ui.styles.ts'
import { Message, type Step } from './SignerSetup.ts'

// The setup's passkey steps: the backup offer after a passkey key is made, the choice when a passkey derives a key
// other than the remembered one, and unlocking a remembered passkey key.

const keyFact = (h: Html.HtmlBuilder<Message>, language: Language, pubkey: string) =>
  Ui.fact(h, say(language, 'signer.key'), Ui.dataText(h, shortHex(pubkey)))

/** A passkey key was made: the person takes the backup or declines it, with what each means said first. */
export const made = (
  h: Html.HtmlBuilder<Message>,
  language: Language,
  step: Extract<Step, { readonly _tag: 'PasskeyMade' }>,
) => [
  Ui.notice(h, 'neutral', [
    h.p([], [say(language, 'signer.passkey.madeLede')]),
    h.p([], [say(language, 'signer.passkey.backupWhy')]),
    h.p([], [say(language, 'signer.passkey.walletRelink')]),
  ]),
  Ui.facts(h, [keyFact(h, language, step.pubkey)]),
  h.div(styled(h, s.actions()), [
    Ui.button(h, {
      label: say(language, 'signer.passkey.backUp'),
      onClick: Message.ClickedBackUpPasskey(),
      kind: 'primary',
      disabled: step.form === 'working',
    }),
    Ui.button(h, {
      label: say(language, 'signer.passkey.skipBackup'),
      onClick: Message.ClickedSkipBackup(),
      busy: step.form === 'working',
    }),
  ]),
]

/** A passkey derived a key other than the one this browser remembers: the person chooses which to use. */
export const otherKey = (
  h: Html.HtmlBuilder<Message>,
  language: Language,
  step: Extract<Step, { readonly _tag: 'PasskeyOtherKey' }>,
) => [
  Ui.notice(h, 'neutral', [h.p([], [say(language, 'signer.passkey.otherLede')])]),
  Ui.facts(h, [
    Ui.fact(h, say(language, 'signer.passkey.found'), Ui.dataText(h, shortHex(step.pubkey))),
    Ui.fact(h, say(language, 'signer.passkey.remembered'), Ui.dataText(h, shortHex(step.other))),
  ]),
  h.div(styled(h, s.actions()), [
    Ui.button(h, {
      label: say(language, 'signer.passkey.useFound'),
      onClick: Message.ClickedUseFoundKey(),
      kind: 'primary',
      busy: step.form === 'working',
    }),
    Ui.linkButton(h, say(language, 'signer.back'), Message.ClickedBack()),
  ]),
]

/** A remembered passkey key, which its passkey derives again; where this page offers no passkeys, only forgetting. */
export const locked = (
  h: Html.HtmlBuilder<Message>,
  language: Language,
  step: Extract<Step, { readonly _tag: 'PasskeyLocked' }>,
  offeredHere: boolean,
) => [
  h.p([], [say(language, offeredHere ? 'signer.passkey.unlockLede' : 'signer.passkey.notHere')]),
  Ui.facts(h, [keyFact(h, language, step.pubkey)]),
  h.div(styled(h, s.actions()), [
    offeredHere
      ? Ui.button(h, {
          label: say(language, step.form === 'working' ? 'signer.passkey.unlocking' : 'signer.passkey.unlock'),
          onClick: Message.ClickedUnlockPasskey(),
          kind: 'primary',
          busy: step.form === 'working',
        })
      : h.empty,
    Ui.linkButton(h, say(language, 'signer.forget'), Message.ClickedForget()),
  ]),
]
