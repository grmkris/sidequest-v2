import { Cursor } from '@sidequest/protocol'
import { Option } from 'effect'
import { click, Command, expect, given, role, scene, text, withViewInputs } from 'foldkit/scene'
import { describe, expect as assert, test } from 'vitest'
import { init, Message, ReadInbox, update, view } from '../../src/page/Inbox.ts'
import { Session } from '../../src/Session.ts'
import { adaSession, job } from '../Fixtures.ts'

const newest = [
  { id: '3', kind: 'message_posted' as const, job, room: null, at: 1_800_000_200 },
  { id: '2', kind: 'funding_recorded' as const, job, room: null, at: 1_800_000_100 },
]
const older = [{ id: '1', kind: 'proposal_submitted' as const, job, room: null, at: 1_800_000_000 }]
const before = Cursor.make('before2')
const signedIn = withViewInputs(view, { session: Session.SignedIn({ session: adaSession }), timeZone: 'UTC' })

describe('the inbox', () => {
  test('asks a signed-out visitor to sign in, and reads nothing', () => {
    const opened = init('en', false, Option.none())
    assert(opened.commands ?? []).toEqual([])
    scene(
      { update, view: withViewInputs(view, { session: Session.SignedOut(), timeZone: 'UTC' })() },
      given(opened.model),
      expect(role('link', { name: 'Sign in' })).toHaveAttr('href', '/sign-in?next=%2Finbox'),
    )
  })

  test('reads the newest items first, pages back to older ones, and checks again on request', () => {
    scene(
      { update, view: signedIn() },
      given(
        update(init('en', true, Option.none()).model, Message.SucceededReadInbox({ items: newest, next: before }))
          .model,
      ),
      expect(role('list', { name: 'Inbox' })).toHaveText(/^A new message.*The escrow was funded/su),
      expect(role('link', { name: 'The escrow was funded' })).toHaveAttr('href', `/jobs/${job}`),
      click(role('button', { name: 'Show more' })),
      Command.resolve(
        ReadInbox({ maybeCursor: Option.some(before) }),
        Message.SucceededReadInbox({ items: older, next: null }),
      ),
      expect(role('list', { name: 'Inbox' })).toHaveText(/^A new message.*The escrow was funded.*A proposal arrived/su),
      expect(role('button', { name: 'Show more' })).not.toExist(),
      click(role('button', { name: 'Check for new items' })),
      expect(role('button', { name: 'Check for new items' })).toBeDisabled(),
      expect(role('link', { name: 'A new message' })).toExist(),
      Command.resolve(ReadInbox({ maybeCursor: Option.none() }), Message.SucceededReadInbox({ items: [], next: null })),
      expect(text(/Nothing yet\./u)).toExist(),
    )
  })

  test('shows the newest page the server read, and reads nothing as it opens', () => {
    const opened = init('en', true, Option.some({ items: newest, next: null, latest: Cursor.make('latest3') }))
    assert(opened.commands ?? []).toEqual([])
    scene(
      { update, view: signedIn() },
      given(opened.model),
      expect(role('list', { name: 'Inbox' })).toHaveText(/^A new message.*The escrow was funded/su),
    )
  })
})
