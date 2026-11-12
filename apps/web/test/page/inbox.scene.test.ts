import { click, Command, expect, given, role, scene, text, withViewInputs } from 'foldkit/scene'
import { describe, test } from 'vitest'
import { init, Message, ReadInbox, update, view } from '../../src/page/Inbox.ts'
import { Session } from '../../src/Session.ts'
import { adaSession, job } from '../Fixtures.ts'

const entries = [
  { id: '2', kind: 'funding_recorded' as const, job, room: null, at: 1_800_000_100 },
  { id: '1', kind: 'proposal_submitted' as const, job, room: null, at: 1_800_000_000 },
]

describe('the inbox', () => {
  test('asks a signed-out visitor to sign in, and reads nothing', () => {
    scene(
      { update, view: withViewInputs(view, { session: Session.SignedOut() })() },
      given(init('en', false).model),
      expect(role('link', { name: 'Sign in' })).toHaveAttr('href', '/sign-in?next=%2Finbox'),
    )
  })

  test('shows items in the order read, newest first, each linking to its job, and checks again on request', () => {
    scene(
      { update, view: withViewInputs(view, { session: Session.SignedIn({ session: adaSession }) })() },
      given(update(init('en', true).model, Message.SucceededReadInbox({ entries })).model),
      expect(role('list', { name: 'Inbox' })).toHaveText(/^The escrow was funded.*A proposal arrived/su),
      expect(role('link', { name: 'A proposal arrived' })).toHaveAttr('href', `/jobs/${job}`),
      click(role('button', { name: 'Check for new items' })),
      expect(role('button', { name: 'Check for new items' })).toBeDisabled(),
      Command.resolve(ReadInbox, Message.SucceededReadInbox({ entries: [] })),
      expect(text(/Nothing yet\./u)).toExist(),
    )
  })
})
