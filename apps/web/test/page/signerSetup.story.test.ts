import { Option, Redacted } from 'effect'
import { Command, expectOutMessage, given, message, model, story } from 'foldkit/story'
import { describe, expect, test } from 'vitest'
import {
  ConfirmBackup,
  ConnectExtension,
  CreateKey,
  DetectSigner,
  ForgetSigner,
  init,
  Message,
  OutMessage,
  RestoreKey,
  Step,
  UnlockKey,
  update,
} from '../../src/page/SignerSetup.ts'

const pubkey = 'ab'.repeat(32)
const ncryptsec =
  'ncryptsec1qgg9947rlpvqu76pj5ecreduf9jxhselq2nae2kghhvd5g7dgjtcxfqtd67p9m0w57lspw8gsq6yphnm8623nsl8xn9j4jdzz84zm3frztj3z7s35vpzmqf6ksu8r89qk5z2zxfmu5gv8th8wclt0h4p'
const local = { signerKind: 'local', pubkey } as const
const nip07 = { signerKind: 'nip07', pubkey } as const
const password = (value: string) => Redacted.make(value)
const nothingFound = { extension: false, maybeRemembered: Option.none(), maybeUnlocked: Option.none() }

const detecting = init('en').model
const choosing = update(detecting, Message.CompletedDetectSigner(nothingFound)).model

describe('choosing a signer', () => {
  test('looks first, then offers a choice when the browser has no signer', () => {
    story(
      update,
      given(detecting),
      model((setup) => expect(Step.guards.Detecting(setup.step)).toBe(true)),
      message(Message.CompletedDetectSigner({ ...nothingFound, extension: true })),
      model((setup) => {
        expect(Step.guards.Choosing(setup.step)).toBe(true)
        expect(setup.extension).toBe(true)
      }),
      Command.expectNone(),
    )
    expect(init('en').commands?.map(({ name }) => name)).toEqual([DetectSigner.name])
  })

  test('uses the extension, and says so when it refuses', () => {
    story(
      update,
      given(choosing),
      message(Message.ClickedUseExtension()),
      model((setup) => expect(Step.guards.ConnectingExtension(setup.step)).toBe(true)),
      Command.resolve(ConnectExtension, Message.FailedConnectExtension({ reason: 'extensionRefused' })),
      model((setup) => {
        expect(Step.guards.Choosing(setup.step)).toBe(true)
        expect(setup.maybeProblem).toEqual(Option.some('extensionRefused'))
      }),
      message(Message.ClickedUseExtension()),
      Command.resolve(ConnectExtension, Message.SucceededConnectExtension({ identity: nip07 })),
      expectOutMessage(OutMessage.SignerReady({ identity: nip07 })),
      model((setup) => expect(setup.maybeProblem).toEqual(Option.none())),
    )
  })

  test('a new key needs a long enough password, typed the same twice', () => {
    story(
      update,
      given(choosing),
      message(Message.ClickedCreateKey()),
      message(Message.UpdatedPassword({ value: password('short') })),
      message(Message.UpdatedConfirmation({ value: password('short') })),
      message(Message.SubmittedCreateKey()),
      model((setup) => expect(setup.maybeProblem).toEqual(Option.some('passwordTooShort'))),
      Command.expectNone(),
      message(Message.UpdatedPassword({ value: password('long enough') })),
      message(Message.SubmittedCreateKey()),
      model((setup) => expect(setup.maybeProblem).toEqual(Option.some('passwordsDiffer'))),
      Command.expectNone(),
      message(Message.UpdatedConfirmation({ value: password('long enough') })),
      message(Message.SubmittedCreateKey()),
      Command.expectExact(CreateKey({ password: password('long enough') })),
      model((setup) => expect(setup.step).toMatchObject({ _tag: 'Creating', form: 'working' })),
      Command.resolve(CreateKey, Message.SucceededCreateKey({ pubkey, ncryptsec })),
      model((setup) => expect(setup.step).toMatchObject({ _tag: 'BackingUp', ncryptsec, saved: false })),
    )
  })

  test('a new key is not ready until the person confirms they saved its backup', () => {
    const backingUp = update(choosing, Message.SucceededCreateKey({ pubkey, ncryptsec })).model
    story(
      update,
      given(backingUp),
      message(Message.ClickedFinishBackup()),
      model((setup) => {
        expect(Step.guards.BackingUp(setup.step)).toBe(true)
        expect(setup.maybeProblem).toEqual(Option.some('backupNotSaved'))
      }),
      Command.expectNone(),
      message(Message.UpdatedBackupSaved({ saved: true })),
      message(Message.ClickedFinishBackup()),
      Command.resolve(ConfirmBackup, Message.SucceededConfirmBackup({ identity: local })),
      expectOutMessage(OutMessage.SignerReady({ identity: local })),
      model((setup) => expect(setup.step).toEqual({ _tag: 'Ready', identity: local })),
    )
  })

  test('a kept key waits locked for its password, and a wrong one clears the field and says why', () => {
    const locked = update(
      detecting,
      Message.CompletedDetectSigner({ ...nothingFound, maybeRemembered: Option.some(local) }),
    ).model
    story(
      update,
      given(locked),
      model((setup) => expect(setup.step).toMatchObject({ _tag: 'Locked', pubkey })),
      message(Message.UpdatedPassword({ value: password('not it') })),
      message(Message.SubmittedUnlock()),
      Command.expectExact(UnlockKey({ password: password('not it') })),
      model((setup) => expect(setup.step).toMatchObject({ _tag: 'Locked', form: 'working' })),
      Command.resolve(UnlockKey, Message.FailedUnlock({ reason: 'wrongPassword' })),
      model((setup) => {
        expect(setup.step).toMatchObject({ _tag: 'Locked', form: 'editing' })
        expect(Step.guards.Locked(setup.step) && Redacted.value(setup.step.password)).toBe('')
        expect(setup.maybeProblem).toEqual(Option.some('wrongPassword'))
      }),
      message(Message.UpdatedPassword({ value: password('the password') })),
      message(Message.SubmittedUnlock()),
      Command.resolve(UnlockKey, Message.SucceededUnlock({ identity: local })),
      expectOutMessage(OutMessage.SignerReady({ identity: local })),
    )
  })

  test('a signer this tab already unlocked is ready at once; a remembered extension is offered again', () => {
    story(
      update,
      given(detecting),
      message(
        Message.CompletedDetectSigner({
          ...nothingFound,
          maybeRemembered: Option.some(local),
          maybeUnlocked: Option.some(local),
        }),
      ),
      expectOutMessage(OutMessage.SignerReady({ identity: local })),
    )
    story(
      update,
      given(detecting),
      message(Message.CompletedDetectSigner({ ...nothingFound, extension: true, maybeRemembered: Option.some(nip07) })),
      model((setup) => expect(Step.guards.Choosing(setup.step)).toBe(true)),
    )
  })

  test('restores a pasted backup, refusing an empty one before any work', () => {
    story(
      update,
      given(choosing),
      message(Message.ClickedRestoreKey()),
      message(Message.SubmittedRestoreKey()),
      model((setup) => expect(setup.maybeProblem).toEqual(Option.some('backupMissing'))),
      Command.expectNone(),
      message(Message.UpdatedBackup({ value: ncryptsec })),
      message(Message.UpdatedPassword({ value: password('nostr') })),
      message(Message.SubmittedRestoreKey()),
      Command.expectExact(RestoreKey({ ncryptsec, password: password('nostr') })),
      Command.resolve(RestoreKey, Message.SucceededRestoreKey({ identity: local })),
      expectOutMessage(OutMessage.SignerReady({ identity: local })),
    )
  })

  test('forgetting goes back to the choice and tells the page', () => {
    const ready = update(choosing, Message.SucceededUnlock({ identity: local })).model
    story(
      update,
      given(ready),
      message(Message.ClickedForget()),
      Command.resolve(ForgetSigner, Message.CompletedForget()),
      model((setup) => expect(Step.guards.Choosing(setup.step)).toBe(true)),
      expectOutMessage(OutMessage.SignerForgotten()),
    )
  })
})
