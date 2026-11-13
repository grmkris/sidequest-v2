import { format } from '@sidequest/i18n'
import type { AgentGrantStatus, AgentGrantView, GrantScope } from '@sidequest/protocol'
import { Array, Option } from 'effect'
import { AsyncData, type Html, Submodel } from 'foldkit'
import { dayChoices } from '../Forms.ts'
import { signerOnly } from '../Gate.ts'
import type { Language } from '../Language.ts'
import { shortNpub } from '../Names.ts'
import { gatewayRefusalText } from '../Gateway.ts'
import { refusalText, signerFailureText } from '../Publishing.ts'
import { AppRoute, identityHref } from '../route.ts'
import { styled } from '../Styled.ts'
import { formatInstant, type PlainKey, say } from '../Text.ts'
import * as Ui from '../Ui.ts'
import * as s from '../Ui.styles.ts'
import {
  type Act,
  Action,
  type AgentEntry,
  AgentsFailure,
  type GrantChoice,
  grantOf,
  Message,
  type Model,
  type Panel,
} from './Agents.ts'
import * as as from './Agents.styles.ts'
import * as DelegationView from './DelegationView.ts'
import * as Erc8004View from './Erc8004View.ts'

type Reader = { readonly model: Model; readonly language: Language; readonly timeZone: string; readonly me: string }

const scopeKeys: ReadonlyArray<{ readonly scope: GrantScope; readonly label: PlainKey; readonly hint: PlainKey }> = [
  { scope: 'discuss', label: 'agents.scope.discuss', hint: 'agents.scope.discussHint' },
  { scope: 'propose', label: 'agents.scope.propose', hint: 'agents.scope.proposeHint' },
  { scope: 'accept', label: 'agents.scope.accept', hint: 'agents.scope.acceptHint' },
  { scope: 'deliver', label: 'agents.scope.deliver', hint: 'agents.scope.deliverHint' },
]

const scopeLabel = (language: Language, scope: GrantScope): string =>
  Option.match(
    Array.findFirst(scopeKeys, (entry) => entry.scope === scope),
    { onNone: () => scope, onSome: (entry) => say(language, entry.label) },
  )

const statusKeys: Readonly<Record<AgentGrantStatus, PlainKey>> = {
  active: 'agents.status.active',
  expired: 'agents.status.expired',
  notYet: 'agents.status.notYet',
  revoked: 'agents.status.revoked',
}

const actKeys: Readonly<Record<Act, PlainKey>> = {
  create: 'agents.done.create',
  grant: 'agents.done.grant',
  revoke: 'agents.done.revoke',
  pause: 'agents.done.pause',
  resume: 'agents.done.resume',
  delete: 'agents.done.delete',
}

/** Why an act failed, in one sentence; a signer that is not ready links to the identity page. */
export const failureNotice = (h: Html.HtmlBuilder<Message>, language: Language, failure: AgentsFailure) =>
  AgentsFailure.match(failure, {
    Gateway: ({ refusal }) => Ui.notice(h, 'danger', [h.p([], [gatewayRefusalText(language, refusal)])]),
    Index: ({ refusal }) => Ui.notice(h, 'danger', [h.p([], [refusalText(language, refusal)])]),
    SignerFailed: ({ reason }) =>
      Ui.notice(h, 'danger', [
        h.p([], [signerFailureText(language, reason)]),
        h.p([], [h.a([h.Href(identityHref(AppRoute.Agents()))], [say(language, 'me.setUpLink')])]),
      ]),
    Failed: ({ problem }) => Ui.problemNotice(h, language, problem),
  })

/** What the last act did, shown beside the agent it was about, or above the list for a new one. */
const actionNotice = (
  h: Html.HtmlBuilder<Message>,
  language: Language,
  action: Action,
  agent: Option.Option<string>,
) => {
  const about = (maybeAgent: Option.Option<string>) =>
    Option.match(maybeAgent, { onNone: () => Option.isNone(agent), onSome: (one) => Option.contains(agent, one) })
  return Action.match(action, {
    Idle: () => h.empty,
    ConfirmingDelete: () => h.empty,
    Working: ({ maybeAgent }) => (about(maybeAgent) ? Ui.waiting(h, say(language, 'agents.working')) : h.empty),
    Done: ({ maybeAgent, act }) =>
      about(maybeAgent) ? Ui.notice(h, 'done', [h.p([], [say(language, actKeys[act])])]) : h.empty,
    Failed: ({ maybeAgent, failure }) => (about(maybeAgent) ? failureNotice(h, language, failure) : h.empty),
  })
}

const scopeChoice = (
  h: Html.HtmlBuilder<Message>,
  idPrefix: string,
  language: Language,
  grant: GrantChoice,
  entry: (typeof scopeKeys)[number],
  onToggle: (scope: GrantScope, checked: boolean) => Message,
) => {
  const id = `${idPrefix}-scope-${entry.scope}`
  const checked = grant.scopes.includes(entry.scope)
  return h.keyed('div')(entry.scope, styled(h, as.scope()), [
    h.input([
      h.Id(id),
      h.Type('checkbox'),
      h.Value(entry.scope),
      h.Checked(checked),
      h.AriaDescribedBy(`${id}-hint`),
      h.OnChange(() => onToggle(entry.scope, !checked)),
    ]),
    h.span(
      [],
      [
        h.label([h.For(id), ...styled(h, s.label())], [say(language, entry.label)]),
        h.span([h.Id(`${id}-hint`), ...styled(h, s.hint())], [say(language, entry.hint)]),
      ],
    ),
  ])
}

/** The scopes and the days a grant gives. */
const grantFields = (
  h: Html.HtmlBuilder<Message>,
  config: {
    readonly idPrefix: string
    readonly language: Language
    readonly grant: GrantChoice
    readonly invalid: boolean
    readonly onToggle: (scope: GrantScope, checked: boolean) => Message
    readonly onDays: (value: string) => Message
  },
) => {
  const { idPrefix, language, grant } = config
  return [
    h.fieldset(styled(h, s.choices()), [
      h.legend(styled(h, s.legend()), [say(language, 'agents.scopes')]),
      ...scopeKeys.map((entry) => scopeChoice(h, idPrefix, language, grant, entry, config.onToggle)),
    ]),
    config.invalid && Array.isReadonlyArrayEmpty(grant.scopes)
      ? h.p(styled(h, s.fieldError()), [say(language, 'agents.pickScope')])
      : h.empty,
    Ui.selectField(h, {
      id: `${idPrefix}-days`,
      label: say(language, 'agents.validFor'),
      value: grant.days,
      options: dayChoices.map((days) => ({
        value: days,
        label: format(language, 'form.days', { count: Number(days) }),
      })),
      onChange: config.onDays,
    }),
  ]
}

const createForm = (h: Html.HtmlBuilder<Message>, { model, language }: Reader) =>
  h.form(
    [h.OnSubmit(Message.SubmittedCreate()), h.Novalidate(true), ...styled(h, s.form())],
    [
      Ui.textField(h, {
        id: 'agent-label',
        label: say(language, 'agents.label'),
        hint: say(language, 'agents.labelHint'),
        value: model.draft.label,
        onInput: (value) => Message.UpdatedLabel({ value }),
        error:
          model.draft.invalid && (model.draft.label.trim() === '' || model.draft.label.trim().length > 120)
            ? Option.some(format(language, 'agents.labelError', { max: 120 }))
            : Option.none(),
        required: true,
      }),
      ...grantFields(h, {
        idPrefix: 'new',
        language,
        grant: model.draft.grant,
        invalid: model.draft.invalid,
        onToggle: (scope, checked) => Message.ToggledScope({ scope, checked }),
        onDays: (value) => Message.SelectedDays({ value }),
      }),
      h.p(styled(h, s.hint()), [say(language, 'agents.createNote')]),
      actionNotice(h, language, model.action, Option.none()),
      h.div(styled(h, s.actions()), [
        Ui.submit(h, {
          label: say(language, 'agents.create'),
          busy: Action.guards.Working(model.action) && model.action.act === 'create',
        }),
      ]),
    ],
  )

const statusChip = (h: Html.HtmlBuilder<Message>, language: Language, maybeGrant: Option.Option<AgentGrantView>) =>
  Option.match(maybeGrant, {
    onNone: () => Ui.chip(h, say(language, 'agents.status.none')),
    onSome: (grant) =>
      Ui.chip(
        h,
        say(language, statusKeys[grant.status]),
        grant.status === 'active' ? 'done' : grant.status === 'revoked' ? 'danger' : 'neutral',
      ),
  })

const grantLine = (
  h: Html.HtmlBuilder<Message>,
  { language, timeZone }: Reader,
  maybeGrant: Option.Option<AgentGrantView>,
) =>
  Option.match(maybeGrant, {
    onNone: () => h.p(styled(h, s.meta()), [say(language, 'agents.noGrant')]),
    onSome: (grant) =>
      h.p(styled(h, s.meta()), [
        format(language, 'agents.grantSummary', {
          scopes: grant.scopes.map((scope) => scopeLabel(language, scope)).join(', '),
          date: formatInstant(grant.expiresAt, language, timeZone),
        }),
      ]),
  })

/** How to connect an MCP client to the agent: the gateway's MCP URL, and where consent happens. */
const connectSection = (h: Html.HtmlBuilder<Message>, { model, language }: Reader) =>
  h.section(
    [h.AriaLabelledBy('agent-connect'), ...styled(h, s.section())],
    [
      h.h3([h.Id('agent-connect')], [say(language, 'agents.connectTitle')]),
      Option.match(model.maybeGatewayUrl, {
        onNone: () => h.empty,
        onSome: (gateway) =>
          h.div(styled(h, s.section()), [
            h.p([], [say(language, 'agents.connectUrl')]),
            h.p([h.Id('agent-mcp-url')], [Ui.dataText(h, `${gateway}/mcp`)]),
            h.p(styled(h, s.hint()), [say(language, 'agents.connectConsent')]),
          ]),
      }),
    ],
  )

const regrantForm = (h: Html.HtmlBuilder<Message>, { language, model }: Reader, panel: Panel) =>
  h.form(
    [h.OnSubmit(Message.SubmittedGrant()), ...styled(h, s.form())],
    [
      ...grantFields(h, {
        idPrefix: 'panel',
        language,
        grant: panel.grant,
        invalid: false,
        onToggle: (scope, checked) => Message.ToggledPanelScope({ scope, checked }),
        onDays: (value) => Message.SelectedPanelDays({ value }),
      }),
      h.div(styled(h, s.actions()), [
        Ui.submit(h, {
          label: say(language, 'agents.grant'),
          busy: Action.guards.Working(model.action) && model.action.act === 'grant',
        }),
      ]),
    ],
  )

const deleteControls = (h: Html.HtmlBuilder<Message>, { model, language }: Reader, agent: AgentEntry) =>
  Action.guards.ConfirmingDelete(model.action) && model.action.agent === agent.agent
    ? Ui.notice(h, 'neutral', [
        h.p([], [say(language, 'agents.deleteConfirm')]),
        h.div(styled(h, s.actions()), [
          Ui.button(h, {
            label: say(language, 'agents.delete'),
            onClick: Message.ClickedConfirmDelete(),
            kind: 'destructive',
          }),
          Ui.button(h, { label: say(language, 'common.cancel'), onClick: Message.ClickedKeep() }),
        ]),
      ])
    : Ui.button(h, {
        label: say(language, 'agents.delete'),
        onClick: Message.ClickedDelete({ agent: agent.agent }),
        kind: 'destructive',
      })

const panelView = (
  h: Html.HtmlBuilder<Message>,
  reader: Reader,
  agent: AgentEntry,
  panel: Panel,
  maybeGrant: Option.Option<AgentGrantView>,
) => {
  const { model, language } = reader
  const active = Option.filter(maybeGrant, (grant) => grant.status === 'active')
  return h.div(styled(h, as.panel()), [
    Option.match(active, {
      onNone: () => regrantForm(h, reader, panel),
      onSome: (grant) =>
        h.div(styled(h, s.actions()), [
          Ui.button(h, {
            label: say(language, 'agents.revoke'),
            onClick: Message.ClickedRevoke({ agent: agent.agent, grant: grant.event }),
            kind: 'destructive',
          }),
        ]),
    }),
    h.div(styled(h, s.actions()), [
      agent.paused
        ? Ui.button(h, {
            label: say(language, 'agents.resume'),
            onClick: Message.ClickedResume({ agent: agent.agent }),
          })
        : Ui.button(h, { label: say(language, 'agents.pause'), onClick: Message.ClickedPause({ agent: agent.agent }) }),
      deleteControls(h, reader, agent),
    ]),
    connectSection(h, reader),
    h.submodel({
      slotId: 'delegation',
      model: model.delegation,
      view: DelegationView.view,
      viewInputs: { agent: agent.agent, label: agent.label, me: reader.me, timeZone: reader.timeZone },
      toParentMessage: (message) => Message.GotDelegationMessage({ message }),
    }),
    h.div(styled(h, s.actions()), [
      Ui.button(h, { label: say(language, 'agents.close'), onClick: Message.ClickedClosePanel() }),
    ]),
  ])
}

const agentRow = (h: Html.HtmlBuilder<Message>, reader: Reader, agent: AgentEntry) => {
  const { model, language } = reader
  const maybeGrant = Option.flatMap(AsyncData.getData(model.grants), (grants) => grantOf(grants, agent.agent))
  const maybePanel = Option.filter(model.maybePanel, (panel) => panel.agent === agent.agent)
  return h.keyed('li')(agent.agent, styled(h, s.row()), [
    h.div(styled(h, s.sectionHead()), [
      h.h2(styled(h, s.rowTitle()), [agent.label]),
      Option.isSome(maybePanel)
        ? h.empty
        : Ui.button(h, {
            label: say(language, 'agents.manage'),
            onClick: Message.ClickedManage({ agent: agent.agent }),
          }),
    ]),
    h.p(styled(h, s.meta()), [h.span([h.Title(agent.agent)], [shortNpub(agent.agent)])]),
    h.div(styled(h, s.actions()), [
      statusChip(h, language, maybeGrant),
      agent.paused ? Ui.chip(h, say(language, 'agents.paused'), 'danger') : h.empty,
      Ui.chip(h, format(language, 'agents.connections', { count: agent.connections })),
    ]),
    grantLine(h, reader, maybeGrant),
    h.submodel({
      slotId: `erc8004-${agent.agent}`,
      model: model.erc8004,
      view: Erc8004View.view,
      viewInputs: {
        agent: agent.agent,
        maybeMcp: Option.map(model.maybeGatewayUrl, (gateway) => `${gateway}/mcp`),
      },
      toParentMessage: (message) => Message.GotErc8004Message({ message }),
    }),
    actionNotice(h, language, model.action, Option.some(agent.agent)),
    Option.match(maybePanel, {
      onNone: () => h.empty,
      onSome: (panel) => panelView(h, reader, agent, panel, maybeGrant),
    }),
  ])
}

const agentsList = (h: Html.HtmlBuilder<Message>, reader: Reader) =>
  AsyncData.matchData(reader.model.agents, {
    onEmpty: () => Ui.waiting(h, say(reader.language, 'agents.loading')),
    onFailure: (failure) => failureNotice(h, reader.language, failure),
    onData: (agents) =>
      Array.match(agents, {
        onEmpty: () => h.p(styled(h, s.meta()), [say(reader.language, 'agents.empty')]),
        onNonEmpty: (items) =>
          h.ul(
            [h.AriaLabel(say(reader.language, 'agents.title')), ...styled(h, s.rows())],
            items.map((agent) => agentRow(h, reader, agent)),
          ),
      }),
  })

/** On a hostname of the site other than its public URL, where the gateway would refuse the page's signatures. */
const elsewhereNotice = (h: Html.HtmlBuilder<Message>, language: Language, siteUrl: string) =>
  Ui.notice(h, 'neutral', [
    h.p([], [format(language, 'agents.elsewhere', { site: siteUrl.replace(/^https?:\/\//u, '') })]),
    h.p([], [h.a([h.Href(`${siteUrl}/agents`)], [say(language, 'agents.elsewhereLink')])]),
  ])

const agentsView = (h: Html.HtmlBuilder<Message>, reader: Reader) =>
  h.div(styled(h, s.page()), [
    h.section([h.AriaLabel(say(reader.language, 'agents.create')), ...styled(h, s.panel())], [createForm(h, reader)]),
    agentsList(h, reader),
  ])

export const view = Submodel.defineView<Model, Message, { readonly timeZone: string }>((model, { timeZone }, h) => {
  const language = model.language
  return h.div(styled(h, s.page()), [
    Ui.pageHead(h, say(language, 'agents.title'), [say(language, 'agents.lede')]),
    Option.isNone(model.maybeGatewayUrl)
      ? Ui.notice(h, 'neutral', [h.p([], [say(language, 'agents.unavailable')])])
      : Option.isSome(model.maybeElsewhere)
        ? elsewhereNotice(h, language, model.maybeElsewhere.value)
        : signerOnly(h, { language, me: model.me, route: AppRoute.Agents() }, (identity) =>
            agentsView(h, { model, language, timeZone, me: identity.pubkey }),
          ),
  ])
})
