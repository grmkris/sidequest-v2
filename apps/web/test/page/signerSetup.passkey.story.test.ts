import { Option, Redacted } from 'effect'
import { Command, expectOutMessage, given, message, model, story } from 'foldkit/story'
import { describe, expect, test } from 'vitest'
import {
  BackUpPasskey,
  ConfirmBackup,
  CreatePasskey,
  DropCreated,
  FindPasskey,
  init,
  KeepPasskey,
  Message,
  offeredRpId,
  OutMessage,
  Step,
  UnlockPasskey,
  update,
} from '../../src/page/SignerSetup.ts'

// The setup's passkey steps (ADR-0005): offered only where the stage and the browser both can, a backup taken or
// declined by an explicit choice, a key found on another device, and every way PRF turns out missing.

const rpId = 'sidequest.example'
const pubkey = 'ab'.repeat(32)
const remembered = 'cd'.repeat(32)
const ncryptsec = 'ncryptsec1backup'
const passkeyIdentity = { signerKind: 'passkey', pubkey } as const
const password = (value: string) => Redacted.make(value)
const found = { extension: false, passkeys: true, maybeRemembered: Option.none(), maybeUnlocked: Option.none() }

const choosing = update(init('en', Option.some(rpId)).model, Message.CompletedDetectSigner(found)).model
const made = update(choosing, Message.SucceededCreatePasskey({ pubkey })).model

describe('offering passkeys', () => {
  test('only where the stage names a relying party here and the browser has WebAuthn with PRF', () => {
    expect(choosing.passkey).toBe('offered')
    expect(offeredRpId(choosing)).toEqual(Option.some(rpId))
    const stageOffersNone = update(init('en').model, Message.CompletedDetectSigner(found)).model
    expect(stageOffersNone.passkey).toBe('notOffered')
    const browserCannot = update(
      init('en', Option.some(rpId)).model,
      Message.CompletedDetectSigner({ ...found, passkeys: false }),
    ).model
    expect(browserCannot.passkey).toBe('notOffered')
    story(update, given(browserCannot), message(Message.ClickedCreatePasskey()), Command.expectNone())
  })
})

describe('making a passkey key', () => {
  test('takes the backup: a password typed twice, the backup saved, then the key is kept', () => {
    story(
      update,
      given(choosing),
      message(Message.ClickedCreatePasskey()),
      Command.expectExact(CreatePasskey({ rpId })),
      model((setup) => expect(Step.guards.CreatingPasskey(setup.step)).toBe(true)),
      Command.resolve(CreatePasskey, Message.SucceededCreatePasskey({ pubkey })),
      model((setup) => expect(setup.step).toEqual(Step.PasskeyMade({ pubkey, form: 'editing' }))),
      message(Message.ClickedBackUpPasskey()),
      message(Message.ClickedBack()),
      model((setup) => expect(setup.step).toEqual(Step.PasskeyMade({ pubkey, form: 'editing' }))),
      message(Message.ClickedBackUpPasskey()),
      message(Message.UpdatedPassword({ value: password('long enough') })),
      message(Message.UpdatedConfirmation({ value: password('not the same') })),
      message(Message.SubmittedPasskeyBackup()),
      model((setup) => expect(setup.maybeProblem).toEqual(Option.some('passwordsDiffer'))),
      Command.expectNone(),
      message(Message.UpdatedConfirmation({ value: password('long enough') })),
      message(Message.SubmittedPasskeyBackup()),
      Command.resolve(BackUpPasskey, Message.SucceededBackUpPasskey({ pubkey, ncryptsec })),
      model((setup) => expect(setup.step).toEqual(Step.BackingUp({ pubkey, ncryptsec, saved: false }))),
      message(Message.ClickedFinishBackup()),
      model((setup) => expect(setup.maybeProblem).toEqual(Option.some('backupNotSaved'))),
      message(Message.UpdatedBackupSaved({ saved: true })),
      message(Message.ClickedFinishBackup()),
      Command.resolve(ConfirmBackup, Message.SucceededConfirmBackup({ identity: passkeyIdentity })),
      expectOutMessage(OutMessage.SignerReady({ identity: passkeyIdentity })),
    )
  })

  test('declines the backup by its own button, and the key is kept without one', () => {
    story(
      update,
      given(made),
      message(Message.ClickedSkipBackup()),
      model((setup) => expect(setup.step).toEqual(Step.PasskeyMade({ pubkey, form: 'working' }))),
      Command.resolve(KeepPasskey, Message.SucceededKeepPasskey({ identity: passkeyIdentity })),
      expectOutMessage(OutMessage.SignerReady({ identity: passkeyIdentity })),
    )
  })

  test('a failed keep or backup returns to the choice with the reason, the backup’s passwords cleared', () => {
    story(
      update,
      given(made),
      message(Message.ClickedSkipBackup()),
      Command.resolve(KeepPasskey, Message.FailedKeepPasskey({ reason: 'nothingStored' })),
      model((setup) => {
        expect(setup.step).toEqual(Step.PasskeyMade({ pubkey, form: 'editing' }))
        expect(setup.maybeProblem).toEqual(Option.some('nothingStored'))
      }),
      message(Message.ClickedBackUpPasskey()),
      message(Message.UpdatedPassword({ value: password('long enough') })),
      message(Message.UpdatedConfirmation({ value: password('long enough') })),
      message(Message.SubmittedPasskeyBackup()),
      Command.resolve(BackUpPasskey, Message.FailedBackUpPasskey({ reason: 'nothingStored' })),
      model((setup) =>
        expect(setup.step).toMatchObject({ _tag: 'PasskeyBackup', password: password(''), form: 'editing' }),
      ),
    )
  })
})

describe('PRF missing', () => {
  test('at creation: says so, stops offering passkeys and offers the in-browser key', () => {
    story(
      update,
      given(choosing),
      message(Message.ClickedCreatePasskey()),
      Command.resolve(CreatePasskey, Message.FailedCreatePasskey({ reason: 'passkeyNoPrf' })),
      model((setup) => {
        expect(Step.guards.Choosing(setup.step)).toBe(true)
        expect(setup.passkey).toBe('unsupported')
        expect(setup.maybeProblem).toEqual(Option.some('passkeyNoPrf'))
        expect(offeredRpId(setup)).toEqual(Option.none())
      }),
      message(Message.ClickedCreatePasskey()),
      Command.expectNone(),
      message(Message.ClickedUsePasskey()),
      Command.expectNone(),
      message(Message.ClickedCreateKey()),
      model((setup) => expect(Step.guards.Creating(setup.step)).toBe(true)),
    )
  })

  test('when finding a passkey: the same', () => {
    story(
      update,
      given(choosing),
      message(Message.ClickedUsePasskey()),
      Command.expectExact(FindPasskey({ rpId })),
      Command.resolve(FindPasskey, Message.FailedFindPasskey({ reason: 'passkeyNoPrf' })),
      model((setup) => {
        expect(Step.guards.Choosing(setup.step)).toBe(true)
        expect(setup.passkey).toBe('unsupported')
      }),
    )
  })

  test('when unlocking: the remembered key stays, with the reason and the way to forget it', () => {
    const locked = update(
      init('en', Option.some(rpId)).model,
      Message.CompletedDetectSigner({ ...found, maybeRemembered: Option.some(passkeyIdentity) }),
    ).model
    story(
      update,
      given(locked),
      model((setup) => expect(setup.step).toEqual(Step.PasskeyLocked({ pubkey, form: 'editing' }))),
      message(Message.ClickedUnlockPasskey()),
      Command.resolve(UnlockPasskey, Message.FailedUnlock({ reason: 'passkeyNoPrf' })),
      model((setup) => {
        expect(setup.step).toEqual(Step.PasskeyLocked({ pubkey, form: 'editing' }))
        expect(setup.maybeProblem).toEqual(Option.some('passkeyNoPrf'))
      }),
    )
  })

  test('a cancelled prompt says so and keeps offering passkeys', () => {
    story(
      update,
      given(choosing),
      message(Message.ClickedCreatePasskey()),
      Command.resolve(CreatePasskey, Message.FailedCreatePasskey({ reason: 'passkeyCancelled' })),
      model((setup) => {
        expect(setup.passkey).toBe('offered')
        expect(setup.maybeProblem).toEqual(Option.some('passkeyCancelled'))
      }),
    )
  })
})

describe('a passkey key after a reload and on another device', () => {
  test('a remembered passkey key unlocks with its passkey; where none is offered here, it is not tried', () => {
    const remember = Message.CompletedDetectSigner({ ...found, maybeRemembered: Option.some(passkeyIdentity) })
    story(
      update,
      given(update(init('en', Option.some(rpId)).model, remember).model),
      message(Message.ClickedUnlockPasskey()),
      Command.expectExact(UnlockPasskey({ rpId })),
      Command.resolve(UnlockPasskey, Message.SucceededUnlock({ identity: passkeyIdentity })),
      expectOutMessage(OutMessage.SignerReady({ identity: passkeyIdentity })),
    )
    story(
      update,
      given(update(init('en').model, remember).model),
      message(Message.ClickedUnlockPasskey()),
      Command.expectNone(),
      model((setup) => expect(setup.maybeProblem).toEqual(Option.some('passkeyUnavailable'))),
    )
  })

  test('"use my passkey" keeps a found key at once when the browser remembers no other', () => {
    story(
      update,
      given(choosing),
      message(Message.ClickedUsePasskey()),
      Command.resolve(FindPasskey, Message.SucceededFindPasskey({ pubkey, maybeOther: Option.none() })),
      model((setup) => expect(Step.guards.FindingPasskey(setup.step)).toBe(true)),
      Command.resolve(KeepPasskey, Message.SucceededKeepPasskey({ identity: passkeyIdentity })),
      expectOutMessage(OutMessage.SignerReady({ identity: passkeyIdentity })),
    )
  })

  test('a found key other than the remembered one is the person’s choice: use it, or go back and drop it', () => {
    const other = update(
      update(choosing, Message.ClickedUsePasskey()).model,
      Message.SucceededFindPasskey({ pubkey, maybeOther: Option.some(remembered) }),
    )
    expect(other.commands ?? []).toEqual([])
    expect(other.model.step).toEqual(Step.PasskeyOtherKey({ pubkey, other: remembered, form: 'editing' }))
    story(
      update,
      given(other.model),
      message(Message.ClickedUseFoundKey()),
      Command.resolve(KeepPasskey, Message.SucceededKeepPasskey({ identity: passkeyIdentity })),
      expectOutMessage(OutMessage.SignerReady({ identity: passkeyIdentity })),
    )
    story(
      update,
      given(other.model),
      message(Message.ClickedBack()),
      Command.resolve(DropCreated, Message.CompletedDropCreated()),
      model((setup) => expect(Step.guards.Choosing(setup.step)).toBe(true)),
    )
  })
})
