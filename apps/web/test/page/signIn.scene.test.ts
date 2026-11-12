import { SessionView, SignInChallenge } from '@sidequest/protocol'
import { Option, Schema } from 'effect'
import { Command, click, expect, expectOutMessage, given, role, scene, text, withViewInputs } from 'foldkit/scene'
import { describe, test } from 'vitest'
import {
  ConnectWallet,
  init,
  Message,
  OutMessage,
  RequestChallenge,
  SignChallenge,
  SwitchNetwork,
  update,
  VerifySignature,
  view,
} from '../../src/page/SignIn.ts'
import { Problem } from '../../src/Problem.ts'
import { Session } from '../../src/Session.ts'
import { ada, signature, wallet } from '../Fixtures.ts'

const signInView = withViewInputs(view, { language: 'en', session: Session.SignedOut() })
const challenge = Schema.decodeSync(SignInChallenge)({ message: 'Sign in to Sidequest.', expiresAt: 1_800_000_300 })
const session = Schema.decodeSync(SessionView)({
  account: ada,
  wallet: `eip155:5042002:${wallet}`,
  expiresAt: 1_800_600_000,
})
const onArc = { address: wallet, chainId: 5042002 }

describe('signing in with a wallet', () => {
  test('connects, signs the server’s message and hands the session over, then goes where sign-in was asked from', () => {
    scene(
      { update, view: signInView() },
      given(init(Option.some('/inbox'))),
      click(role('button', { name: 'Connect wallet' })),
      expect(role('button', { name: 'Waiting for your wallet…' })).toBeDisabled(),
      Command.resolve(ConnectWallet, Message.SucceededConnectWallet({ connection: onArc })),
      expect(text(wallet)).toExist(),
      click(role('button', { name: 'Sign in' })),
      Command.resolve(RequestChallenge({ address: wallet }), Message.SucceededRequestChallenge({ challenge })),
      expect(role('button', { name: 'Sign the message in your wallet…' })).toExist(),
      Command.resolve(
        SignChallenge({ address: wallet, message: challenge.message }),
        Message.SucceededSignChallenge({ message: challenge.message, signature }),
      ),
      Command.resolve(
        VerifySignature({ message: challenge.message, signature }),
        Message.SucceededVerifySignature({ session }),
      ),
      expectOutMessage(OutMessage.SignedIn({ session, next: '/inbox' })),
    )
  })

  test('offers to switch a wallet on another network to Arc testnet before signing in', () => {
    scene(
      { update, view: signInView() },
      given(init(Option.none())),
      click(role('button', { name: 'Connect wallet' })),
      Command.resolve(ConnectWallet, Message.SucceededConnectWallet({ connection: { address: wallet, chainId: 1 } })),
      expect(text('Another network (chain 1)')).toExist(),
      expect(role('button', { name: 'Sign in' })).not.toExist(),
      click(role('button', { name: 'Switch to Arc testnet' })),
      Command.resolve(SwitchNetwork, Message.SucceededSwitchNetwork()),
      expect(text('Arc testnet')).toExist(),
      expect(role('button', { name: 'Sign in' })).toExist(),
    )
  })

  test('says so when there is no wallet, and lets the person try again', () => {
    scene(
      { update, view: signInView() },
      given(init(Option.none())),
      click(role('button', { name: 'Connect wallet' })),
      Command.resolve(ConnectWallet, Message.FailedConnectWallet({ problem: Problem.NoWallet() })),
      expect(role('alert')).toContainText('No wallet found in this browser'),
      expect(role('button', { name: 'Connect wallet' })).toBeEnabled(),
    )
  })

  test('a rejection in the wallet signs nothing, and Sign in asks for a fresh message', () => {
    scene(
      { update, view: signInView() },
      given(init(Option.none())),
      click(role('button', { name: 'Connect wallet' })),
      Command.resolve(ConnectWallet, Message.SucceededConnectWallet({ connection: onArc })),
      click(role('button', { name: 'Sign in' })),
      Command.resolve(RequestChallenge({ address: wallet }), Message.SucceededRequestChallenge({ challenge })),
      Command.resolve(SignChallenge, Message.FailedSignChallenge({ problem: Problem.WalletRejected() })),
      expect(role('alert')).toContainText('You declined in your wallet. Nothing was signed.'),
      click(role('button', { name: 'Sign in' })),
      Command.expectExact(RequestChallenge({ address: wallet })),
      Command.resolve(RequestChallenge, Message.SucceededRequestChallenge({ challenge })),
      Command.resolve(SignChallenge, Message.SucceededSignChallenge({ message: challenge.message, signature })),
      Command.resolve(
        VerifySignature,
        Message.FailedVerifySignature({ problem: Problem.SignInRefused({ reason: 'expired' }) }),
      ),
      expect(role('alert')).toContainText('The sign-in message expired before it was signed.'),
      expect(role('button', { name: 'Sign in' })).toBeEnabled(),
    )
  })

  test('shows the signed-in wallet and offers to sign out', () => {
    scene(
      { update, view: withViewInputs(view, { language: 'en', session: Session.SignedIn({ session }) })() },
      given(init(Option.none())),
      expect(text('You are signed in.')).toExist(),
      click(role('button', { name: 'Sign out' })),
      expectOutMessage(OutMessage.RequestedSignOut()),
    )
  })
})
