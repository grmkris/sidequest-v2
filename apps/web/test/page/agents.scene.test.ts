import { AgentAccessToken, AgentId, AgentTokenId } from '@sidequest/protocol'
import { Option, Redacted, Schema } from 'effect'
import {
  change,
  Command,
  click,
  expect,
  given,
  label,
  role,
  scene,
  submit,
  text,
  type,
  withViewInputs,
} from 'foldkit/scene'
import { describe, test } from 'vitest'
import {
  CopyToken,
  GrantAgent,
  init,
  IssueToken,
  ListAgents,
  ListTokens,
  Message,
  RegisterAgent,
  RevokeAgent,
  RevokeToken,
  update,
} from '../../src/page/Agents.ts'
import { view } from '../../src/page/AgentsView.ts'
import { Session } from '../../src/Session.ts'
import { ada, adaSession } from '../Fixtures.ts'

const signedIn = withViewInputs(view, {
  session: Session.SignedIn({ session: adaSession }),
  origin: 'https://sidequest.example',
  timeZone: 'UTC',
})
const scout = AgentId.make('agent_01JQ0000000000000000000SC1')
const tokenId = AgentTokenId.make('token_01JQ0000000000000000000TK1')
const secret = Schema.decodeSync(AgentAccessToken)(`sqa_${'f'.repeat(64)}`)
const agent = { id: scout, operator: ada, name: 'Scout', revoked: false }
const listed = update(init('en', true, Option.none()).model, Message.SucceededListAgents({ agents: [agent] })).model
const issued = { id: tokenId, agent: scout, issuedAt: 1_800_000_000, expiresAt: 1_802_592_000, revokedAt: null }

describe('the agents page', () => {
  test('registers an agent by name, then lists it again', () => {
    scene(
      { update, view: signedIn() },
      given(listed),
      submit(role('form')),
      Command.expectNone(),
      expect(text('Give it a name of at most 80 characters.')).toExist(),
      type(label('Agent name'), ' Courier '),
      submit(role('form')),
      Command.resolve(RegisterAgent({ name: 'Courier' }), Message.SucceededRegisterAgent({ agent: scout })),
      Command.resolve(ListAgents, Message.SucceededListAgents({ agents: [agent] })),
      expect(label('Agent name')).toHaveValue(''),
    )
  })

  test('grants the scopes picked until a chosen number of days, and revokes the agent', () => {
    scene(
      { update, view: signedIn() },
      given(listed),
      expect(text('No grant yet')).toExist(),
      click(role('button', { name: 'Manage' })),
      Command.resolve(ListTokens({ agent: scout }), Message.SucceededListTokens({ agent: scout, tokens: [] })),
      change(label('Propose'), 'propose'),
      click(role('button', { name: 'Save grant' })),
      Command.resolve(
        GrantAgent({ agent: scout, scopes: ['discuss', 'propose'], days: '30' }),
        Message.SucceededGrantAgent({ agent: scout }),
      ),
      Command.resolve(
        ListAgents,
        Message.SucceededListAgents({
          agents: [{ ...agent, grant: { scopes: ['discuss', 'propose'], expiresAt: 1_802_592_000 } }],
        }),
      ),
      expect(text(/May Talk, Propose until/u)).toExist(),
      click(role('button', { name: 'Revoke agent' })),
      Command.resolve(RevokeAgent({ agent: scout }), Message.SucceededRevokeAgent({ agent: scout })),
      Command.resolve(ListAgents, Message.SucceededListAgents({ agents: [{ ...agent, revoked: true }] })),
      expect(text('Revoked')).toExist(),
    )
  })

  test('shows a new token once, copies it, and hides it for good', () => {
    scene(
      { update, view: signedIn() },
      given(listed),
      click(role('button', { name: 'Manage' })),
      Command.resolve(ListTokens, Message.SucceededListTokens({ agent: scout, tokens: [] })),
      expect(text('https://sidequest.example/mcp', { exact: false })).toExist(),
      click(role('button', { name: 'Issue a token' })),
      Command.resolve(
        IssueToken({ agent: scout }),
        Message.SucceededIssueToken({ agent: scout, token: { ...issued, token: secret } }),
      ),
      Command.resolve(ListTokens, Message.SucceededListTokens({ agent: scout, tokens: [issued] })),
      expect(text(secret)).toExist(),
      click(role('button', { name: 'Copy token' })),
      Command.resolve(CopyToken({ token: Redacted.make(secret) }), Message.CompletedCopyToken({ copied: true })),
      expect(role('button', { name: 'Copied' })).toExist(),
      click(role('button', { name: 'Done, hide it' })),
      expect(text(secret)).not.toExist(),
      click(role('button', { name: 'Revoke token' })),
      Command.resolve(RevokeToken({ agent: scout, token: tokenId }), Message.SucceededRevokeToken({ agent: scout })),
      Command.resolve(
        ListTokens,
        Message.SucceededListTokens({ agent: scout, tokens: [{ ...issued, revokedAt: 1_800_000_500 }] }),
      ),
      expect(role('button', { name: 'Revoke token' })).not.toExist(),
    )
  })
})
