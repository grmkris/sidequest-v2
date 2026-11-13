import { OpenJob } from '../src/OpenJob.ts'
import { Option, Schema } from 'effect'
import { Command, expect, given, role, scene, text } from 'foldkit/scene'
import { fromString } from 'foldkit/url'
import { describe, expect as assert, test } from 'vitest'
import { init, Message, type Model, update } from '../src/App.ts'
import { type Flags, Page } from '../src/Model.ts'
import { Preload } from '../src/Preload.ts'
import { FocusTitle, NavigateInternal } from '../src/Navigation.ts'
import { DetectMe, Me, Message as MeMessage, ReadMe, Standing } from '../src/Me.ts'
import * as Home from '../src/page/Home.ts'
import * as Job from '../src/page/job/Job.ts'
import * as Inbox from '../src/page/Inbox.ts'
import { view } from '../src/View.ts'
import { bidderKey, buyerKey, foldedJob, now, requestId } from './Fixtures.ts'

const flags = (preload: Preload = Preload.Nothing()): Flags => ({
  language: 'en',
  timeZone: 'UTC',
  release: 'test',
  origin: 'https://sidequest.example',
  preload,
  defaultInboxRelays: [],
  maybeGatewayUrl: Option.none(),
  maybeSiteUrl: Option.none(),
  maybePasskeyRpId: Option.none(),
})

const urlOf = (path: string) =>
  Option.getOrThrowWith(fromString(`https://sidequest.example${path}`), () => new Error(`Not a URL: ${path}`))

const opened = (path: string): Model => init(flags(), urlOf(path)).model

describe('the app', () => {
  test('reads the time zone and looks for the signer, and nothing about a session', () => {
    assert(init(flags(), urlOf('/evidence')).commands?.map((command) => command.name)).toEqual([
      'ReadTimeZone',
      DetectMe.name,
    ])
  })

  test('hydrates the page the server rendered from its data, reading it not again', () => {
    const preload = Preload.Home({
      requests: {
        items: [
          Schema.decodeSync(OpenJob)({
            job: requestId,
            buyer: buyerKey,
            createdAt: now,
            request: { title: 'A logo for my café', description: 'Warm colours.', expiresAt: 1_800_600_000 },
            expired: false,
            proposals: 0,
          }),
        ],
        next: null,
      },
      listings: { items: [], next: null },
      names: [{ pubkey: buyerKey, name: 'Ada Lovelace', walletVerified: true }],
    })
    const hydrated = init(flags(preload), urlOf('/'))
    assert(hydrated.commands?.map((command) => command.name)).toEqual(['ReadTimeZone', DetectMe.name])
    scene(
      { update, view },
      given(hydrated.model),
      expect(role('button', { name: 'Sign out' })).not.toExist(),
      expect(role('link', { name: 'A logo for my café' })).toHaveAttr('href', `/jobs/${requestId}`),
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
    const model = init(flags(preload), urlOf('/')).model
    const changed = update(model, Message.ChangedUrl({ url: urlOf(`/jobs/${requestId}`) }))
    assert(changed.commands?.map((command) => command.name)).toEqual(['ReadJob', FocusTitle.name])
  })

  test('the browser’s signer is who the marketplace pages act as: shown in the header and told to the open page', () => {
    const identity = { signerKind: 'nip07', pubkey: bidderKey } as const
    const onJob = init(flags(Preload.Job({ view: foldedJob(), names: [] })), urlOf(`/jobs/${requestId}`)).model
    const detected = update(
      onJob,
      Message.GotMeMessage({ message: MeMessage.CompletedDetectMe({ maybeIdentity: Option.some(identity) }) }),
    )
    assert(detected.commands?.map((command) => [command.name, command.args])).toEqual([
      [ReadMe.name, { pubkey: bidderKey }],
    ])
    const known = update(
      detected.model,
      Message.GotMeMessage({
        message: MeMessage.SucceededReadMe({
          pubkey: bidderKey,
          maybeName: Option.some('Ben'),
          wallets: [],
          agents: [],
        }),
      }),
    ).model
    assert(known.me).toEqual(
      Me.Ready({ identity, standing: Standing.Known({ maybeName: Option.some('Ben'), wallets: [], agents: [] }) }),
    )
    assert(Page.guards.Job(known.page) && known.page.job.me).toEqual(known.me)
    scene({ update, view }, given(known), expect(role('link', { name: 'Identity' })).toHaveText('Ben'))
  })

  test('an action without a signer goes to the identity page, which comes back to the page', () => {
    const onJob = init(flags(Preload.Job({ view: foldedJob(), names: [] })), urlOf(`/jobs/${requestId}`)).model
    const noSigner = update(
      onJob,
      Message.GotMeMessage({ message: MeMessage.CompletedDetectMe({ maybeIdentity: Option.none() }) }),
    ).model
    const clicked = update(noSigner, Message.GotJobMessage({ message: Job.Message.ClickedPropose() }))
    assert(clicked.commands?.map((command) => [command.name, command.args])).toEqual([
      [NavigateInternal.name, { href: `/identity?next=${encodeURIComponent(`/jobs/${requestId}`)}` }],
    ])
  })

  test('the inbox reads what needs the signer the browser finds, and nothing before', () => {
    const onInbox = opened('/inbox')
    assert(Page.guards.Inbox(onInbox.page) && onInbox.page.inbox.maybeReadFor).toEqual(Option.none())
    const identity = { signerKind: 'nip07', pubkey: buyerKey } as const
    const detected = update(
      onInbox,
      Message.GotMeMessage({ message: MeMessage.CompletedDetectMe({ maybeIdentity: Option.some(identity) }) }),
    )
    assert(detected.commands?.map((command) => [command.name, command.args])).toEqual([
      [ReadMe.name, { pubkey: buyerKey }],
      [Inbox.ReadInbox.name, { pubkey: buyerKey }],
      [Inbox.ReadUnread.name, { pubkey: buyerKey }],
      [Inbox.ReadSeen.name, { pubkey: buyerKey }],
    ])
  })

  test('the header has no sign-in: the person is their Nostr identity', () => {
    scene(
      { update, view },
      given(opened('/')),
      expect(role('link', { name: 'Identity' })).toExist(),
      expect(role('link', { name: 'Sign in' })).not.toExist(),
    )
  })

  test('a followed link opens the page in the document and gives its title focus', () => {
    scene(
      { update, view },
      given(opened('/')),
      expect(role('link', { name: 'Inbox' })).toHaveAttr('href', '/inbox'),
      Command.expectNone(),
    )
    const changed = update(opened('/'), Message.ChangedUrl({ url: urlOf('/inbox') }))
    assert(changed.commands?.map((command) => command.name)).toEqual([FocusTitle.name])
    const searched = update(opened('/'), Message.ChangedUrl({ url: urlOf('/?q=logo') }))
    assert(searched.commands?.map((command) => command.name)).toEqual([Home.SearchListings.name])
  })
})
