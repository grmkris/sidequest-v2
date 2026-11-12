import { SignInChallenge } from '@sidequest/protocol'
import { Option, Schema } from 'effect'
import { Command, click, expect, given, role, scene, text } from 'foldkit/scene'
import { fromString } from 'foldkit/url'
import { describe, expect as assert, test } from 'vitest'
import { init, Message, type Model, SignOut, update } from '../src/App.ts'
import type { Flags } from '../src/Model.ts'
import { Preload, SessionRead } from '../src/Preload.ts'
import { FocusTitle, NavigateInternal, ReplaceInternal } from '../src/Navigation.ts'
import * as Home from '../src/page/Home.ts'
import * as SignIn from '../src/page/SignIn.ts'
import { Problem } from '../src/Problem.ts'
import { view } from '../src/View.ts'
import { ada, adaSession, job, signature, wallet } from './Fixtures.ts'

const flags = (
  hasSessionCookie: boolean,
  sessionRead: SessionRead = SessionRead.Unread(),
  preload: Preload = Preload.Nothing(),
): Flags => ({
  language: 'en',
  timeZone: 'UTC',
  release: 'test',
  origin: 'https://sidequest.example',
  hasSessionCookie,
  sessionRead,
  preload,
})

const urlOf = (path: string) =>
  Option.getOrThrowWith(fromString(`https://sidequest.example${path}`), () => new Error(`Not a URL: ${path}`))

const opened = (path: string, hasSessionCookie: boolean): Model => init(flags(hasSessionCookie), urlOf(path)).model

const commandsOf = (stamped: Flags) => init(stamped, urlOf('/sign-in')).commands?.map((command) => command.name)

describe('the app', () => {
  test('reads the session only when the request carried a session cookie the server did not read', () => {
    assert(commandsOf(flags(true))).toEqual(['ReadTimeZone', 'ReadSession'])
    assert(commandsOf(flags(false))).toEqual(['ReadTimeZone'])
    assert(commandsOf(flags(true, SessionRead.SignedIn({ session: adaSession })))).toEqual(['ReadTimeZone'])
    assert(commandsOf(flags(true, SessionRead.SignedOut()))).toEqual(['ReadTimeZone'])
  })

  test('hydrates the page the server rendered from its data and session, reading neither again', () => {
    const preload = Preload.Home({
      requests: { items: [{ id: job, buyer: ada, title: 'A logo for my café', expiresAt: 1_800_600_000 }], next: null },
      listings: { items: [], next: null },
      names: [{ account: ada, displayName: 'Ada Lovelace' }],
    })
    const hydrated = init(flags(true, SessionRead.SignedIn({ session: adaSession }), preload), urlOf('/'))
    assert(hydrated.commands?.map((command) => command.name)).toEqual(['ReadTimeZone'])
    scene(
      { update, view },
      given(hydrated.model),
      expect(text('Wallet 0x1111…1111')).toExist(),
      expect(role('link', { name: 'A logo for my café' })).toHaveAttr('href', `/jobs/${job}`),
      expect(text('Ada Lovelace · open until Jan 22, 2027, 6:40 AM')).toExist(),
    )
    // The browser then reads its own time zone and draws dates in it.
    scene(
      { update, view },
      given(update(hydrated.model, Message.CompletedReadTimeZone({ timeZone: 'Europe/Ljubljana' })).model),
      expect(text('Ada Lovelace · open until Jan 22, 2027, 7:40 AM')).toExist(),
    )
  })

  test('opens a page reached in the browser without the server’s data, and reads it', () => {
    const preload = Preload.Home({
      requests: { items: [], next: null },
      listings: { items: [], next: null },
      names: [],
    })
    const model = init(flags(false, SessionRead.Unread(), preload), urlOf('/')).model
    const changed = update(model, Message.ChangedUrl({ url: urlOf(`/jobs/${job}`) }))
    assert(changed.commands?.map((command) => command.name)).toEqual(['ReadJob', FocusTitle.name])
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
