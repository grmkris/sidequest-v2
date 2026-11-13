import { Option } from 'effect'
import { Command, given, message, model, story } from 'foldkit/story'
import { describe, expect, test } from 'vitest'
import {
  Action,
  ConnectWallet,
  init,
  Message,
  PersonRead,
  PublishProfile,
  PublishRefusal,
  PublishWalletLink,
  ReadPerson,
  SignWalletLink,
  update,
} from '../../src/page/Identity.ts'
import * as SignerSetup from '../../src/page/SignerSetup.ts'
import { Problem } from '../../src/Problem.ts'
import { signature, wallet } from '../Fixtures.ts'

const pubkey = 'cd'.repeat(32)
const identity = { signerKind: 'local', pubkey } as const
const account = `eip155:5042002:${wallet.toLowerCase()}`
const linked = { maybeName: Option.some('Ada'), wallets: [{ account, verification: 'verified' }] } as const

const ready = update(
  init('en').model,
  Message.GotSetupMessage({ message: SignerSetup.Message.SucceededUnlock({ identity }) }),
).model

describe('a person’s Nostr identity', () => {
  test('reads what the index knows of the key once the signer is ready, and nothing before', () => {
    story(update, given(init('en').model), message(Message.ClickedLinkWallet()), Command.expectNone())
    story(
      update,
      given(init('en').model),
      message(Message.GotSetupMessage({ message: SignerSetup.Message.SucceededUnlock({ identity }) })),
      Command.expectExact(ReadPerson({ pubkey })),
      Command.resolve(ReadPerson, Message.CompletedReadUnknownPerson()),
      model((page) => expect(page.person).toEqual(PersonRead.Unknown())),
    )
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
      model((page) => {
        expect(page.person).toEqual(PersonRead.Unread())
        expect(SignerSetup.Step.guards.Choosing(page.setup.step)).toBe(true)
      }),
      message(Message.ClickedLinkWallet()),
      Command.expectNone(),
    )
  })
})
