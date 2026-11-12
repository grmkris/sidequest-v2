import { SignInChallenge } from '@sidequest/protocol'
import { Option, Schema } from 'effect'
import { Command, click, expect, given, role, scene, text } from 'foldkit/scene'
import { fromString } from 'foldkit/url'
import { describe, expect as assert, test } from 'vitest'
import { init, Message, type Model, SignOut, update } from '../src/App.ts'
import type { Flags } from '../src/Model.ts'
import { FocusTitle, NavigateInternal, ReplaceInternal } from '../src/Navigation.ts'
import * as Home from '../src/page/Home.ts'
import * as SignIn from '../src/page/SignIn.ts'
import { Problem } from '../src/Problem.ts'
import { view } from '../src/View.ts'
import { adaSession, signature, wallet } from './Fixtures.ts'

const flags = (hasSessionCookie: boolean): Flags => ({
  language: 'en',
  release: 'test',
  origin: 'https://sidequest.example',
  hasSessionCookie,
})

const urlOf = (path: string) =>
  Option.getOrThrowWith(fromString(`https://sidequest.example${path}`), () => new Error(`Not a URL: ${path}`))

const opened = (path: string, hasSessionCookie: boolean): Model => init(flags(hasSessionCookie), urlOf(path)).model

describe('the app', () => {
  test('reads the session only when the request carried a session cookie', () => {
    assert(init(flags(true), urlOf('/sign-in')).commands?.map((command) => command.name)).toEqual(['ReadSession'])
    assert(init(flags(false), urlOf('/sign-in')).commands ?? []).toEqual([])
  })

  test('signing in on the sign-in page puts the wallet in the header and returns to the page it was asked from', () => {
    const challenge = Schema.decodeSync(SignInChallenge)({ message: 'Sign in to Sidequest.', expiresAt: 1_800_000_300 })
    scene(
      { update, view },
      given(opened('/sign-in?next=%2Finbox', false)),
      expect(role('link', { name: 'Sign in' })).toExist(),
      click(role('button', { name: 'Connect wallet' })),
      Command.resolve(
        SignIn.ConnectWallet,
        SignIn.Message.SucceededConnectWallet({ connection: { address: wallet, chainId: 5042002 } }),
      ),
      click(role('button', { name: 'Sign in' })),
      Command.resolve(SignIn.RequestChallenge, SignIn.Message.SucceededRequestChallenge({ challenge })),
      Command.resolve(
        SignIn.SignChallenge,
        SignIn.Message.SucceededSignChallenge({ message: challenge.message, signature }),
      ),
      Command.resolve(SignIn.VerifySignature, SignIn.Message.SucceededVerifySignature({ session: adaSession })),
      expect(text('Wallet 0x1111…1111')).toExist(),
      Command.resolve(ReplaceInternal({ href: '/inbox' }), Message.CompletedNavigate()),
    )
  })

  test('a session read from the cookie shows in the header, and signing out goes home', () => {
    scene(
      { update, view },
      given(update(opened('/agents', true), Message.SucceededReadSession({ session: adaSession })).model),
      expect(role('button', { name: 'Sign out' })).toExist(),
      click(role('button', { name: 'Sign out' })),
      expect(text('Signing out…')).toExist(),
      Command.resolve(SignOut, Message.SucceededSignOut()),
      expect(role('link', { name: 'Sign in' })).toExist(),
      Command.resolve(NavigateInternal({ href: '/' }), Message.CompletedNavigate()),
    )
  })

  test('a failed sign-out keeps the session and says why', () => {
    scene(
      { update, view },
      given(update(opened('/', true), Message.SucceededReadSession({ session: adaSession })).model),
      click(role('button', { name: 'Sign out' })),
      Command.resolve(SignOut, Message.FailedSignOut({ problem: Problem.Unavailable() })),
      expect(role('alert')).toContainText('Sidequest could not reach its database'),
      expect(role('button', { name: 'Sign out' })).toExist(),
    )
  })

  test('a followed link opens the page in the document and gives its title focus', () => {
    scene(
      { update, view },
      given(update(opened('/', false), Message.FailedReadSession({ problem: Problem.NotSignedIn() })).model),
      expect(role('link', { name: 'Inbox' })).toHaveAttr('href', '/inbox'),
      Command.expectNone(),
    )
    const changed = update(opened('/', false), Message.ChangedUrl({ url: urlOf('/inbox') }))
    assert(changed.commands?.map((command) => command.name)).toEqual([FocusTitle.name])
    const searched = update(opened('/', false), Message.ChangedUrl({ url: urlOf('/?q=logo') }))
    assert(searched.commands?.map((command) => command.name)).toEqual([Home.SearchListings.name])
  })
})
