import { format } from '@sidequest/i18n'
import type { Agent, AgentToken, GrantScope } from '@sidequest/protocol'
import { Array, Option, Redacted } from 'effect'
import { AsyncData, type Html, Submodel } from 'foldkit'
import { dayChoices, FormStatus, formProblem, shown } from '../Forms.ts'
import { signedInOnly } from '../Gate.ts'
import type { Language } from '../Language.ts'
import { AppRoute } from '../route.ts'
import type { Session } from '../Session.ts'
import { styled } from '../Styled.ts'
import { formatInstant, type PlainKey, say } from '../Text.ts'
import * as Ui from '../Ui.ts'
import * as s from '../Ui.styles.ts'
import { Action, Issue, Message, type Model, type Panel } from './Agents.ts'
import * as as from './Agents.styles.ts'

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

const grantSummary = (h: Html.HtmlBuilder<Message>, language: Language, agent: Agent) => {
  if (agent.revoked) {
    return Ui.chip(h, say(language, 'agents.revoked'), 'danger')
  }
  return Option.match(Option.fromNullishOr(agent.grant), {
    onNone: () => Ui.chip(h, say(language, 'agents.noGrant')),
    onSome: (grant) =>
      h.span(styled(h, s.meta()), [
        format(language, 'agents.grantSummary', {
          scopes: grant.scopes.map((scope) => scopeLabel(language, scope)).join(', '),
          date: formatInstant(grant.expiresAt, language),
        }),
      ]),
  })
}

const scopeChoice = (
  h: Html.HtmlBuilder<Message>,
  language: Language,
  panel: Panel,
  entry: (typeof scopeKeys)[number],
) =>
  h.keyed('div')(entry.scope, styled(h, as.scope()), [
    h.input([
      h.Id(`scope-${entry.scope}`),
      h.Type('checkbox'),
      h.Name('scope'),
      h.Value(entry.scope),
      h.Checked(panel.scopes.includes(entry.scope)),
      h.AriaDescribedBy(`scope-${entry.scope}-hint`),
      h.OnChange(() => Message.ToggledScope({ scope: entry.scope, checked: !panel.scopes.includes(entry.scope) })),
    ]),
    h.span(
      [],
      [
        h.label([h.For(`scope-${entry.scope}`), ...styled(h, s.label())], [say(language, entry.label)]),
        h.span([h.Id(`scope-${entry.scope}-hint`), ...styled(h, s.hint())], [say(language, entry.hint)]),
      ],
    ),
  ])

const grantForm = (h: Html.HtmlBuilder<Message>, language: Language, panel: Panel) =>
  h.form(
    [h.OnSubmit(Message.SubmittedGrant()), ...styled(h, s.form())],
    [
      h.fieldset(styled(h, s.choices()), [
        h.legend(styled(h, s.legend()), [say(language, 'agents.scopes')]),
        ...scopeKeys.map((entry) => scopeChoice(h, language, panel, entry)),
      ]),
      Option.match(shown(panel.grant, Option.some(say(language, 'agents.pickScope'))), {
        onNone: () => h.empty,
        onSome: (error) => h.p(styled(h, s.fieldError()), [error]),
      }),
      Ui.selectField(h, {
        id: 'grant-days',
        label: say(language, 'agents.validFor'),
        value: panel.days,
        options: dayChoices.map((days) => ({
          value: days,
          label: format(language, 'form.days', { count: Number(days) }),
        })),
        onChange: (value) => Message.SelectedGrantDays({ value }),
      }),
      Ui.maybeProblem(h, language, formProblem(panel.grant)),
      h.div(styled(h, s.actions()), [
        Ui.submit(h, { label: say(language, 'agents.saveGrant'), busy: FormStatus.guards.Submitting(panel.grant) }),
      ]),
    ],
  )

const issuedView = (h: Html.HtmlBuilder<Message>, language: Language, issue: Issue) =>
  Issue.match(issue, {
    Idle: () => h.empty,
    Issuing: () => h.empty,
    Failed: ({ problem }) => Ui.problemNotice(h, language, problem),
    Issued: ({ token, copied }) =>
      Ui.notice(h, 'done', [
        h.p([], [say(language, 'agents.tokenOnce')]),
        h.p([h.Id('issued-token'), ...styled(h, as.token())], [Redacted.value(token)]),
        h.div(styled(h, s.actions()), [
          Ui.button(h, {
            label: copied ? say(language, 'agents.copied') : say(language, 'agents.copy'),
            onClick: Message.ClickedCopyToken(),
            kind: 'primary',
          }),
          Ui.button(h, { label: say(language, 'agents.stored'), onClick: Message.ClickedDismissToken() }),
        ]),
      ]),
  })

const tokenRow = (h: Html.HtmlBuilder<Message>, language: Language, token: AgentToken) =>
  h.keyed('li')(token.id, styled(h, s.row()), [
    h.p(
      [],
      [
        format(language, 'agents.tokenIssued', {
          issued: formatInstant(token.issuedAt, language),
          expires: formatInstant(token.expiresAt, language),
        }),
      ],
    ),
    token.revokedAt === null
      ? h.div(styled(h, s.actions()), [
          Ui.button(h, {
            label: say(language, 'agents.revokeToken'),
            onClick: Message.ClickedRevokeToken({ token: token.id }),
            kind: 'destructive',
          }),
        ])
      : Ui.chip(h, say(language, 'agents.tokenRevoked')),
  ])

const tokensView = (h: Html.HtmlBuilder<Message>, language: Language, panel: Panel, origin: string) =>
  h.section(
    [h.AriaLabelledBy('agent-tokens'), ...styled(h, s.section())],
    [
      h.h3([h.Id('agent-tokens')], [say(language, 'agents.tokens')]),
      h.p(styled(h, s.meta()), [format(language, 'agents.endpoint', { url: `${origin}/mcp` })]),
      h.div(styled(h, s.actions()), [
        Ui.button(h, {
          label: say(language, 'agents.issue'),
          onClick: Message.ClickedIssueToken(),
          busy: Issue.guards.Issuing(panel.issue),
        }),
      ]),
      issuedView(h, language, panel.issue),
      AsyncData.matchData(panel.tokens, {
        onEmpty: () => Ui.waiting(h, say(language, 'agents.tokensLoading')),
        onFailure: (problem) => Ui.problemNotice(h, language, problem),
        onData: (tokens) =>
          Array.match(tokens, {
            onEmpty: () => h.p(styled(h, s.meta()), [say(language, 'agents.noTokens')]),
            onNonEmpty: (items) =>
              h.ul(
                [h.AriaLabel(say(language, 'agents.tokens')), ...styled(h, s.rows())],
                items.map((token) => tokenRow(h, language, token)),
              ),
          }),
      }),
    ],
  )

const panelView = (h: Html.HtmlBuilder<Message>, language: Language, panel: Panel, agent: Agent, origin: string) =>
  h.div(styled(h, as.panel()), [
    agent.revoked ? h.p(styled(h, s.meta()), [say(language, 'agents.revokedNote')]) : grantForm(h, language, panel),
    agent.revoked ? h.empty : tokensView(h, language, panel, origin),
    agent.revoked
      ? h.empty
      : h.div(styled(h, s.actions()), [
          Ui.button(h, {
            label: say(language, 'agents.revokeAgent'),
            onClick: Message.ClickedRevokeAgent(),
            kind: 'destructive',
            busy: Action.guards.Working(panel.revoke),
          }),
        ]),
    Action.guards.Failed(panel.revoke) ? Ui.problemNotice(h, language, panel.revoke.problem) : h.empty,
    h.div(styled(h, s.actions()), [
      Ui.button(h, { label: say(language, 'agents.close'), onClick: Message.ClickedClose() }),
    ]),
  ])

const agentRow = (h: Html.HtmlBuilder<Message>, model: Model, agent: Agent, origin: string) => {
  const maybeOpen = Option.filter(model.maybePanel, (panel) => panel.agent === agent.id)
  return h.keyed('li')(agent.id, styled(h, s.row()), [
    h.div(styled(h, s.sectionHead()), [
      h.h2(styled(h, s.rowTitle()), [agent.name]),
      Option.isSome(maybeOpen)
        ? h.empty
        : Ui.button(h, {
            label: say(model.language, 'agents.manage'),
            onClick: Message.ClickedManage({ agent: agent.id }),
          }),
    ]),
    grantSummary(h, model.language, agent),
    Option.match(maybeOpen, {
      onNone: () => h.empty,
      onSome: (panel) => panelView(h, model.language, panel, agent, origin),
    }),
  ])
}

const registerForm = (h: Html.HtmlBuilder<Message>, model: Model) =>
  h.form(
    [h.OnSubmit(Message.SubmittedAgent()), h.Novalidate(true), ...styled(h, s.form())],
    [
      Ui.textField(h, {
        id: 'agent-name',
        label: say(model.language, 'agents.name'),
        hint: say(model.language, 'agents.nameHint'),
        value: model.name,
        onInput: (value) => Message.UpdatedName({ value }),
        error: shown(model.register, Option.some(format(model.language, 'agents.nameError', { max: 80 }))),
        required: true,
      }),
      Ui.maybeProblem(h, model.language, formProblem(model.register)),
      h.div(styled(h, s.actions()), [
        Ui.submit(h, {
          label: say(model.language, 'agents.register'),
          busy: FormStatus.guards.Submitting(model.register),
        }),
      ]),
    ],
  )

const agentsView = (h: Html.HtmlBuilder<Message>, model: Model, origin: string) =>
  h.div(styled(h, s.page()), [
    h.section([h.AriaLabel(say(model.language, 'agents.register')), ...styled(h, s.panel())], [registerForm(h, model)]),
    AsyncData.matchData(model.agents, {
      onEmpty: () => Ui.waiting(h, say(model.language, 'agents.loading')),
      onFailure: (problem) => Ui.problemNotice(h, model.language, problem),
      onData: (agents) =>
        Array.match(agents, {
          onEmpty: () => h.p(styled(h, s.meta()), [say(model.language, 'agents.empty')]),
          onNonEmpty: (items) =>
            h.ul(
              [h.AriaLabel(say(model.language, 'agents.title')), ...styled(h, s.rows())],
              items.map((agent) => agentRow(h, model, agent, origin)),
            ),
        }),
    }),
  ])

export const view = Submodel.defineView<Model, Message, { readonly session: Session; readonly origin: string }>(
  (model, { session, origin }, h) =>
    h.div(styled(h, s.page()), [
      Ui.pageHead(h, say(model.language, 'agents.title'), [say(model.language, 'agents.lede')]),
      signedInOnly(h, { language: model.language, session, route: AppRoute.Agents() }, () =>
        agentsView(h, model, origin),
      ),
    ]),
)
