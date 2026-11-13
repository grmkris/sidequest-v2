import { AgentGrantView } from '@sidequest/protocol'
import { Option, Schema } from 'effect'
import { AsyncData } from 'foldkit'
import { Command, given, message, model, story } from 'foldkit/story'
import { describe, expect, test } from 'vitest'
import { GatewayRefusal, GatewayRefused, refusalOf } from '../../src/Gateway.ts'
import { Me, Standing } from '../../src/Me.ts'
import {
  Action,
  AgentsFailure,
  agentsFailureOf,
  CreateAgent,
  DeleteAgent,
  elsewhereOf,
  grantOf,
  init,
  ListAgents,
  Message,
  type Model,
  PublishGrant,
  PublishRevocation,
  ReadGrants,
  SetPause,
  update,
} from '../../src/page/Agents.ts'
import { Problem } from '../../src/Problem.ts'
import { PublishRefusal } from '../../src/Publishing.ts'
import { SignerFailed } from '../../src/Signer.ts'
import { buyerKey, now } from '../Fixtures.ts'

const gateway = Option.some('https://gateway.test')
const me = Me.Ready({
  identity: { signerKind: 'nip07', pubkey: buyerKey },
  standing: Standing.Known({ maybeName: Option.none(), wallets: [], agents: [] }),
})
const agent = 'a9'.repeat(32)
const entry = { agent, label: 'Scout', createdAt: now, paused: false, connections: 1 }

const grantFor = (status: AgentGrantView['status'], event = 'e7'.repeat(32), notBefore = now): AgentGrantView =>
  Schema.decodeSync(AgentGrantView)({
    event,
    operator: buyerKey,
    agent,
    scopes: ['discuss', 'propose'],
    notBefore,
    expiresAt: now + 86_400,
    label: 'Scout',
    status,
  })

/** The page with the person's agents listed and their grants read. */
const listed = (grants: ReadonlyArray<AgentGrantView> = [grantFor('active')]): Model => {
  const opened = init('en', me, gateway).model
  const withAgents = update(opened, Message.SucceededListAgents({ pubkey: buyerKey, agents: [entry] })).model
  return update(withAgents, Message.SucceededReadGrants({ pubkey: buyerKey, grants })).model
}

/** The page reads its agents and grants again; they answer. */
const relisted = [
  Command.resolve(ListAgents, Message.SucceededListAgents({ pubkey: buyerKey, agents: [entry] })),
  Command.resolve(ReadGrants, Message.SucceededReadGrants({ pubkey: buyerKey, grants: [] })),
]
const regranted = Command.resolve(ReadGrants, Message.SucceededReadGrants({ pubkey: buyerKey, grants: [] }))

describe('the agents page', () => {
  test('on a stage without a gateway, reads nothing at all', () => {
    const opened = init('en', me, Option.none())
    expect(opened.commands).toBeUndefined()
    expect(opened.model.agents).toEqual(AsyncData.Idle())
  })

  test('waits for the signer, then reads its agents at the gateway and its grants in the index', () => {
    const detecting = init('en', Me.Detecting(), gateway)
    expect(detecting.commands).toBeUndefined()
    const opened = init('en', me, gateway)
    expect(opened.commands?.map((command) => [command.name, command.args])).toEqual([
      [ListAgents.name, { pubkey: buyerKey }],
      [ReadGrants.name, { pubkey: buyerKey }],
    ])
  })

  test('makes an agent at the gateway, then signs its first grant, then reads both again', () => {
    story(
      update,
      given(listed()),
      message(Message.UpdatedLabel({ value: '  Scout  ' })),
      message(Message.ToggledScope({ scope: 'accept', checked: true })),
      message(Message.SelectedDays({ value: '7' })),
      message(Message.SubmittedCreate()),
      Command.expectExact(
        CreateAgent({ label: 'Scout', grant: { scopes: ['discuss', 'propose', 'accept'], days: '7' } }),
      ),
      Command.resolve(
        CreateAgent,
        Message.SucceededCreateAgent({
          agent,
          label: 'Scout',
          grant: { scopes: ['discuss', 'propose', 'accept'], days: '7' },
        }),
      ),
      Command.expectExact(
        PublishGrant({ agent, label: 'Scout', scopes: ['discuss', 'propose', 'accept'], days: '7', act: 'create' }),
      ),
      Command.resolve(PublishGrant, Message.SucceededAct({ agent, act: 'create' })),
      model((page) => {
        expect(page.action).toEqual(Action.Done({ maybeAgent: Option.some(agent), act: 'create' }))
        expect(page.draft.label).toBe('')
      }),
      Command.expectExact(ListAgents({ pubkey: buyerKey }), ReadGrants({ pubkey: buyerKey })),
      ...relisted,
    )
  })

  test('refuses an agent without a label or without a scope, before the gateway', () => {
    story(
      update,
      given(listed()),
      message(Message.SubmittedCreate()),
      model((page) => expect(page.draft.invalid).toBe(true)),
      Command.expectNone(),
    )
    story(
      update,
      given(listed()),
      message(Message.UpdatedLabel({ value: 'Scout' })),
      message(Message.ToggledScope({ scope: 'discuss', checked: false })),
      message(Message.ToggledScope({ scope: 'propose', checked: false })),
      message(Message.SubmittedCreate()),
      Command.expectNone(),
    )
  })

  test('every gateway refusal of a new agent stops it with that refusal', () => {
    for (const refusal of [
      GatewayRefusal.NotConfigured(),
      GatewayRefusal.Unauthorized({ reason: 'stale' }),
      GatewayRefusal.TooManyAgents(),
      GatewayRefusal.Invalid(),
      GatewayRefusal.Unavailable(),
      GatewayRefusal.Unreachable(),
    ]) {
      const failure = AgentsFailure.Gateway({ refusal })
      story(
        update,
        given(listed()),
        message(Message.UpdatedLabel({ value: 'Scout' })),
        message(Message.SubmittedCreate()),
        Command.resolve(CreateAgent, Message.FailedAct({ maybeAgent: Option.none(), act: 'create', failure })),
        model((page) =>
          expect(page.action).toEqual(Action.Failed({ maybeAgent: Option.none(), act: 'create', failure })),
        ),
        Command.expectNone(),
      )
    }
  })

  test('a new agent whose grant the index refused stays listed without one, to grant again', () => {
    const failure = AgentsFailure.Index({ refusal: PublishRefusal.RateLimited({ retryAfterSeconds: 30 }) })
    story(
      update,
      given(listed([])),
      message(Message.UpdatedLabel({ value: 'Scout' })),
      message(Message.SubmittedCreate()),
      Command.resolve(
        CreateAgent,
        Message.SucceededCreateAgent({ agent, label: 'Scout', grant: { scopes: ['discuss'], days: '30' } }),
      ),
      Command.resolve(PublishGrant, Message.FailedAct({ maybeAgent: Option.some(agent), act: 'create', failure })),
      Command.expectExact(ListAgents({ pubkey: buyerKey })),
      Command.resolve(ListAgents, Message.SucceededListAgents({ pubkey: buyerKey, agents: [entry] })),
      model((page) =>
        expect(page.action).toEqual(Action.Failed({ maybeAgent: Option.some(agent), act: 'create', failure })),
      ),
    )
  })

  test('shows an active grant, else the latest, and none for an agent never granted', () => {
    const active = grantFor('active', 'a1'.repeat(32), now - 10)
    const older = grantFor('revoked', 'b1'.repeat(32), now - 100)
    const newer = grantFor('expired', 'c1'.repeat(32), now)
    expect(grantOf([older, active, newer], agent)).toEqual(Option.some(active))
    expect(grantOf([newer, older], agent)).toEqual(Option.some(newer))
    expect(grantOf([older], agent)).toEqual(Option.some(older))
    expect(grantOf([older], 'f0'.repeat(32))).toEqual(Option.none())
  })

  test('revokes the active grant with a signed revocation, and reads the grants again', () => {
    const grant = grantFor('active')
    story(
      update,
      given(listed([grant])),
      message(Message.ClickedManage({ agent })),
      message(Message.ClickedRevoke({ agent, grant: grant.event })),
      Command.expectExact(PublishRevocation({ agent, grant: grant.event })),
      Command.resolve(PublishRevocation, Message.SucceededAct({ agent, act: 'revoke' })),
      Command.expectExact(ReadGrants({ pubkey: buyerKey })),
      regranted,
      model((page) => expect(page.action).toEqual(Action.Done({ maybeAgent: Option.some(agent), act: 'revoke' }))),
    )
  })

  test('grants an agent again from its panel, under its label', () => {
    story(
      update,
      given(listed([grantFor('expired')])),
      message(Message.ClickedManage({ agent })),
      message(Message.SelectedPanelDays({ value: '14' })),
      message(Message.SubmittedGrant()),
      Command.expectExact(
        PublishGrant({ agent, label: 'Scout', scopes: ['discuss', 'propose'], days: '14', act: 'grant' }),
      ),
      Command.resolve(PublishGrant, Message.SucceededAct({ agent, act: 'grant' })),
      Command.expectExact(ReadGrants({ pubkey: buyerKey })),
      regranted,
      model((page) => expect(page.action).toEqual(Action.Done({ maybeAgent: Option.some(agent), act: 'grant' }))),
    )
  })

  test('pauses and resumes the agent at the gateway, and lists again', () => {
    story(
      update,
      given(listed()),
      message(Message.ClickedPause({ agent })),
      Command.expectExact(SetPause({ agent, paused: true })),
      Command.resolve(SetPause, Message.SucceededAct({ agent, act: 'pause' })),
      Command.expectExact(ListAgents({ pubkey: buyerKey }), ReadGrants({ pubkey: buyerKey })),
      ...relisted,
      message(Message.ClickedResume({ agent })),
      Command.expectExact(SetPause({ agent, paused: false })),
      Command.resolve(SetPause, Message.SucceededAct({ agent, act: 'resume' })),
      Command.expectExact(ListAgents({ pubkey: buyerKey }), ReadGrants({ pubkey: buyerKey })),
      ...relisted,
      model((page) => expect(page.action).toEqual(Action.Done({ maybeAgent: Option.some(agent), act: 'resume' }))),
    )
  })

  test('deletes only once confirmed, and an unknown agent is the gateway’s refusal', () => {
    const unknown = AgentsFailure.Gateway({ refusal: GatewayRefusal.UnknownAgent() })
    story(
      update,
      given(listed()),
      message(Message.ClickedDelete({ agent })),
      Command.expectNone(),
      message(Message.ClickedKeep()),
      model((page) => expect(page.action).toEqual(Action.Idle())),
      message(Message.ClickedDelete({ agent })),
      message(Message.ClickedConfirmDelete()),
      Command.expectExact(DeleteAgent({ agent })),
      Command.resolve(
        DeleteAgent,
        Message.FailedAct({ maybeAgent: Option.some(agent), act: 'delete', failure: unknown }),
      ),
      model((page) =>
        expect(page.action).toEqual(Action.Failed({ maybeAgent: Option.some(agent), act: 'delete', failure: unknown })),
      ),
    )
  })

  test('a list the gateway refused shows its refusal; an answer for an earlier signer is dropped', () => {
    const failure = AgentsFailure.Gateway({ refusal: GatewayRefusal.Unauthorized({ reason: 'stale' }) })
    const failed = update(init('en', me, gateway).model, Message.FailedListAgents({ pubkey: buyerKey, failure }))
    expect(failed.model.agents).toEqual(AsyncData.Failure({ error: failure }))
    const stale = update(
      init('en', me, gateway).model,
      Message.SucceededListAgents({ pubkey: 'f0'.repeat(32), agents: [entry] }),
    )
    expect(stale.model.agents).toEqual(AsyncData.Loading())
  })
})

describe('the agents page on another hostname of the site', () => {
  test('sends people to the site’s own URL and calls the gateway for nothing, since it accepts NIP-98 only there', () => {
    const site = 'https://v2.sidequest.exchange'
    expect(elsewhereOf(site, Option.some(site))).toEqual(Option.none())
    expect(elsewhereOf('https://edge.example.workers.dev', Option.some(site))).toEqual(Option.some(site))
    expect(elsewhereOf('https://edge.example.workers.dev', Option.none())).toEqual(Option.none())
    const opened = init('en', me, gateway, Option.some(site))
    expect(opened.commands ?? []).toEqual([])
    expect(opened.model.maybeElsewhere).toEqual(Option.some(site))
    expect((init('en', me, gateway, Option.none()).commands ?? []).map(({ name }) => name)).toEqual([
      ListAgents.name,
      ReadGrants.name,
    ])
  })
})

describe('the gateway’s answers', () => {
  test('are each read as their refusal', () => {
    expect(refusalOf(404, { error: 'gateway_not_configured' })).toEqual(GatewayRefusal.NotConfigured())
    expect(refusalOf(401, { error: 'unauthorized', reason: 'replayed' })).toEqual(
      GatewayRefusal.Unauthorized({ reason: 'replayed' }),
    )
    expect(refusalOf(401, null)).toEqual(GatewayRefusal.Unauthorized({ reason: 'missing' }))
    expect(refusalOf(404, { error: 'unknown_agent' })).toEqual(GatewayRefusal.UnknownAgent())
    expect(refusalOf(404, { error: 'unknown_delegation' })).toEqual(GatewayRefusal.UnknownAgent())
    expect(refusalOf(409, { error: 'too_many_agents' })).toEqual(GatewayRefusal.TooManyAgents())
    expect(refusalOf(400, { error: 'invalid_request' })).toEqual(GatewayRefusal.Invalid())
    expect(refusalOf(503, { error: 'unavailable' })).toEqual(GatewayRefusal.Unavailable())
    expect(refusalOf(502, { error: 'gateway_unreachable' })).toEqual(GatewayRefusal.Unreachable())
    expect(refusalOf(404, { error: 'not_found' })).toEqual(GatewayRefusal.Unreachable())
  })

  test('and every error of an act as its failure', () => {
    expect(agentsFailureOf(new GatewayRefused({ refusal: GatewayRefusal.TooManyAgents() }))).toEqual(
      AgentsFailure.Gateway({ refusal: GatewayRefusal.TooManyAgents() }),
    )
    expect(agentsFailureOf(new SignerFailed({ reason: 'extensionRefused' }))).toEqual(
      AgentsFailure.SignerFailed({ reason: 'extensionRefused' }),
    )
    expect(agentsFailureOf(new Error('network'))).toEqual(AgentsFailure.Failed({ problem: Problem.Unreachable() }))
  })
})
