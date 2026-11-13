import { Option } from 'effect'
import { Command, expectOutMessage, given, message, model, story } from 'foldkit/story'
import { describe, expect, test } from 'vitest'
import {
  Action,
  ConnectWallet,
  init,
  Message,
  offersProfile,
  OutMessage,
  PersonRead,
  PublishProfile,
  PublishWalletLink,
  ReadPerson,
  SignWalletLink,
  update,
} from '../../src/page/Identity.ts'
import * as SignerSetup from '../../src/page/SignerSetup.ts'
import { Standing } from '../../src/Me.ts'
import { Problem } from '../../src/Problem.ts'
import { PublishRefusal } from '../../src/Publishing.ts'
import { signature, wallet } from '../Fixtures.ts'

const pubkey = 'cd'.repeat(32)
const identity = { signerKind: 'local', pubkey } as const
const account = `eip155:5042002:${wallet.toLowerCase()}`
const linked = {
  hasProfile: true,
  maybeName: Option.some('Ada'),
  wallets: [{ account, verification: 'verified' }],
  inboxRelays: [],
} as const
const fresh = init('en', Option.none(), []).model

/** The identity page once `signer` is ready and the index answered what it knows of the key. */
const readyWith = (signer: typeof identity | typeof extension, answer: Message) =>
  update(
    update(fresh, Message.GotSetupMessage({ message: SignerSetup.Message.SucceededUnlock({ identity: signer }) }))
      .model,
    answer,
  ).model
const extension = { signerKind: 'nip07', pubkey } as const
const ready = readyWith(identity, Message.CompletedReadUnknownPerson())

describe('a person’s Nostr identity', () => {
  test('reads what the index knows of the key once the signer is ready, and tells the site whose key it is', () => {
    story(update, given(fresh), message(Message.ClickedLinkWallet()), Command.expectNone())
    story(
      update,
      given(fresh),
      message(Message.GotSetupMessage({ message: SignerSetup.Message.SucceededUnlock({ identity }) })),
      expectOutMessage(OutMessage.SignerReady({ identity })),
      Command.expectExact(ReadPerson({ pubkey })),
      Command.resolve(ReadPerson, Message.CompletedReadUnknownPerson()),
      expectOutMessage(
        OutMessage.StandingRead({ pubkey, standing: Standing.Known({ maybeName: Option.none(), wallets: [] }) }),
      ),
      model((page) => expect(page.person).toEqual(PersonRead.Unknown())),
    )
  })

  test('offers a name-only profile only for a key made here that the index knows no profile of', () => {
    const noProfile = Message.SucceededReadPerson({
      person: { ...linked, hasProfile: false, maybeName: Option.none() },
    })
    expect(offersProfile(readyWith(identity, Message.CompletedReadUnknownPerson()))).toBe(true)
    expect(offersProfile(readyWith(identity, noProfile))).toBe(true)
    // A profile replaces the whole of the one before: never over an existing one, nor for an extension's key.
    expect(offersProfile(readyWith(identity, Message.SucceededReadPerson({ person: linked })))).toBe(false)
    expect(offersProfile(readyWith(extension, Message.CompletedReadUnknownPerson()))).toBe(false)
    expect(offersProfile(readyWith(extension, noProfile))).toBe(false)
    // Nor before the index answered, or when it could not.
    expect(offersProfile(readyWith(identity, Message.FailedReadPerson({ problem: Problem.Unreachable() })))).toBe(false)
    for (const known of [
      readyWith(extension, Message.CompletedReadUnknownPerson()),
      readyWith(identity, Message.SucceededReadPerson({ person: linked })),
    ]) {
      story(
        update,
        given(update(known, Message.UpdatedName({ value: 'Ada' })).model),
        message(Message.SubmittedProfile()),
        Command.expectNone(),
        model((page) => expect(page.action).toEqual(Action.Idle())),
      )
    }
  })

  test('publishes a profile with a name, and shows what the index then knows', () => {
    story(
      update,
      given(ready),
      message(Message.SubmittedProfile()),
      model((page) => expect(page.action).toEqual(Action.NameInvalid())),
      Command.expectNone(),
      message(Message.UpdatedName({ value: '  Ada ' })),
      model((page) => expect(page.action).toEqual(Action.Idle())),
      message(Message.SubmittedProfile()),
      Command.expectExact(PublishProfile({ name: 'Ada' })),
      model((page) => expect(page.action).toEqual(Action.Publishing({ publication: 'profile' }))),
      Command.resolve(PublishProfile, Message.SucceededPublish({ publication: 'profile' })),
      model((page) => expect(page.action).toEqual(Action.Published({ publication: 'profile' }))),
      Command.resolve(ReadPerson({ pubkey }), Message.SucceededReadPerson({ person: linked })),
      expectOutMessage(
        OutMessage.StandingRead({
          pubkey,
          standing: Standing.Known({ maybeName: Option.some('Ada'), wallets: [account] }),
        }),
      ),
      model((page) => expect(page.person).toEqual(PersonRead.Read({ person: linked }))),
    )
  })

  test('links the wallet: the wallet signs, then the key signs the link, then the index is read again', () => {
    story(
      update,
      given(ready),
      message(Message.ClickedLinkWallet()),
      model((page) => expect(page.action).toEqual(Action.ConnectingWallet())),
      Command.resolve(
        ConnectWallet,
        Message.SucceededConnectWallet({ connection: { address: wallet, chainId: 5042002 } }),
      ),
      model((page) => expect(page.action).toEqual(Action.SigningInWallet())),
      Command.expectExact(SignWalletLink({ address: wallet, chainId: 5042002, pubkey })),
      Command.resolve(
        SignWalletLink,
        Message.SucceededSignWalletLink({ account, issuedAt: 1_800_000_000, walletSignature: signature }),
      ),
      Command.expectExact(PublishWalletLink({ account, issuedAt: 1_800_000_000, walletSignature: signature })),
      model((page) => expect(page.action).toEqual(Action.Publishing({ publication: 'walletLink' }))),
      Command.resolve(PublishWalletLink, Message.SucceededPublish({ publication: 'walletLink' })),
      Command.resolve(ReadPerson, Message.SucceededReadPerson({ person: linked })),
      model((page) => {
        expect(page.action).toEqual(Action.Published({ publication: 'walletLink' }))
        expect(page.person).toEqual(PersonRead.Read({ person: linked }))
      }),
    )
  })

  test('a wallet that says no is a declined link, and any other wallet failure is a problem', () => {
    story(
      update,
      given(ready),
      message(Message.ClickedLinkWallet()),
      Command.resolve(
        ConnectWallet,
        Message.SucceededConnectWallet({ connection: { address: wallet, chainId: 5042002 } }),
      ),
      Command.resolve(SignWalletLink, Message.FailedSignWalletLink({ problem: Problem.WalletRejected() })),
      model((page) => expect(page.action).toEqual(Action.WalletDeclined())),
      Command.expectNone(),
      message(Message.ClickedLinkWallet()),
      Command.resolve(ConnectWallet, Message.FailedConnectWallet({ problem: Problem.NoWallet() })),
      model((page) => expect(page.action).toEqual(Action.Failed({ problem: Problem.NoWallet() }))),
    )
  })

  test('shows the index’s typed refusal, and a signer that could not sign', () => {
    const named = update(ready, Message.UpdatedName({ value: 'Ada' })).model
    story(
      update,
      given(named),
      message(Message.SubmittedProfile()),
      Command.resolve(
        PublishProfile,
        Message.RefusedPublish({ refusal: PublishRefusal.RateLimited({ retryAfterSeconds: 30 }) }),
      ),
      model((page) =>
        expect(page.action).toEqual(Action.Refused({ refusal: PublishRefusal.RateLimited({ retryAfterSeconds: 30 }) })),
      ),
      Command.expectNone(),
      message(Message.SubmittedProfile()),
      Command.resolve(PublishProfile, Message.FailedSign({ reason: 'locked' })),
      model((page) => expect(page.action).toEqual(Action.SignerFailed({ reason: 'locked' }))),
    )
  })

  test('forgetting the signer leaves nothing of the key on the page', () => {
    const read = update(ready, Message.SucceededReadPerson({ person: linked })).model
    story(
      update,
      given(read),
      message(Message.GotSetupMessage({ message: SignerSetup.Message.CompletedForget() })),
      expectOutMessage(OutMessage.SignerForgotten()),
      model((page) => {
        expect(page.person).toEqual(PersonRead.Unread())
        expect(SignerSetup.Step.guards.Choosing(page.setup.step)).toBe(true)
      }),
      message(Message.ClickedLinkWallet()),
      Command.expectNone(),
    )
  })
})
