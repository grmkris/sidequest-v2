import { AgentId, ConnectionId, ConnectRequestId } from '@sidequest/protocol'
import { Option } from 'effect'
import { change, Command, click, expect, given, label, role, scene, text, withViewInputs } from 'foldkit/scene'
import { describe, test } from 'vitest'
import { AnswerRequest, init, LeaveForClient, Message, update } from '../../src/page/Connect.ts'
import * as Connections from '../../src/page/Connections.ts'
import { view as connectionsView } from '../../src/page/ConnectionsView.ts'
import { view } from '../../src/page/ConnectView.ts'
import { Session } from '../../src/Session.ts'
import { ada, adaSession } from '../Fixtures.ts'

const signedIn = { session: Session.SignedIn({ session: adaSession }) }
const request = ConnectRequestId.make('connect_01JQ0000000000000000000RQ1')
const scout = AgentId.make('agent_01JQ0000000000000000000SC1')
const retired = AgentId.make('agent_01JQ0000000000000000000RT1')
const asking = {
  id: request,
  client: { id: 'client_0123', name: 'Claude', kind: 'registered' as const, publisher: null },
  redirect: { host: '127.0.0.1:43117', loopback: true },
  resource: 'https://sidequest.example/mcp',
  expiresAt: 1_800_000_600,
}
const agents = [
  {
    id: scout,
    operator: ada,
    name: 'Scout',
    revoked: false,
    grant: { scopes: ['discuss' as const], expiresAt: 1_900_000_000 },
  },
  { id: retired, operator: ada, name: 'Retired', revoked: true },
]
/** The page once the request and the person's agents were read. */
const shown = update(
  update(init('en', request, true).model, Message.SucceededReadRequest({ request: asking })).model,
  Message.SucceededListAgents({ agents }),
).model
const redirect = 'http://127.0.0.1:43117/callback?code=sqc_x&state=s&iss=https%3A%2F%2Fsidequest.example'

describe('the consent page', () => {
  test('shows who asks and where the access goes, and allows only once an agent is picked', () => {
    scene(
      { update, view: withViewInputs(view, signedIn)() },
      given(shown),
      expect(text('Claude wants to act as one of your agents')).toExist(),
      expect(text(/registered itself: its name is its own claim/u)).toExist(),
      expect(text('127.0.0.1:43117')).toExist(),
      expect(text('An app on this device')).toExist(),
      expect(label('Retired')).toBeDisabled(),
      expect(role('button', { name: 'Allow' })).toBeDisabled(),
      change(label('Scout'), scout),
      click(role('button', { name: 'Allow' })),
      Command.resolve(
        AnswerRequest({ request, maybeAgent: Option.some(scout) }),
        Message.SucceededAnswer({ redirect }),
      ),
      Command.resolve(LeaveForClient({ href: redirect }), Message.CompletedLeave()),
      expect(text('Returning to the app…')).toExist(),
    )
  })

  test('refuses without an agent, and says when the request no longer waits', () => {
    scene(
      { update, view: withViewInputs(view, signedIn)() },
      given(shown),
      click(role('button', { name: 'Refuse' })),
      Command.resolve(AnswerRequest({ request, maybeAgent: Option.none() }), Message.FoundAnswerGone()),
      expect(text(/no longer waiting/u)).toExist(),
    )
  })

  test('asks a signed-out person to sign in first', () => {
    scene(
      { update, view: withViewInputs(view, { session: Session.SignedOut() })() },
      given(init('en', request, false).model),
      Command.expectNone(),
      expect(role('link', { name: 'Sign in' })).toExist(),
    )
  })
})

describe('the connected apps page', () => {
  test('lists a connection and revokes it', () => {
    const connection = ConnectionId.make('connection_01JQ0000000000000000000CN1')
    const listed = {
      id: connection,
      agent: scout,
      client: {
        id: 'https://claude.example/oauth/client',
        name: 'Claude',
        kind: 'published' as const,
        publisher: 'claude.example',
      },
      redirect: { host: 'claude.example', loopback: false },
      connectedAt: 1_800_000_000,
    }
    scene(
      { update: Connections.update, view: withViewInputs(connectionsView, signedIn)() },
      given(
        Connections.update(
          Connections.init('en', true).model,
          Connections.Message.SucceededListConnections({ connections: [listed] }),
        ).model,
      ),
      expect(text('Published by claude.example.')).toExist(),
      click(role('button', { name: 'Revoke' })),
      Command.resolve(Connections.RevokeConnection({ connection }), Connections.Message.SucceededRevoke()),
      Command.resolve(Connections.ListConnections, Connections.Message.SucceededListConnections({ connections: [] })),
      expect(text('No apps are connected.')).toExist(),
    )
  })
})
