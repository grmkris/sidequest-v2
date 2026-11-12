import { format } from '@sidequest/i18n'
import type { Agent, ConnectRequest } from '@sidequest/protocol'
import { Array, Option } from 'effect'
import { AsyncData, type Html, Submodel } from 'foldkit'
import { signedInOnly } from '../Gate.ts'
import type { Language } from '../Language.ts'
import { AppRoute, agentsRouter } from '../route.ts'
import type { Session } from '../Session.ts'
import { styled } from '../Styled.ts'
import { formatInstant, say } from '../Text.ts'
import * as Ui from '../Ui.ts'
import * as s from '../Ui.styles.ts'
import { Answer, Asking, Message, type Model, pickable } from './Connect.ts'
import * as as from './Agents.styles.ts'
import { scopeLabel } from './AgentsView.ts'

/**
 * Who asks, as far as anyone can tell: a client known by its published document is named with the host that
 * publishes it; a client that registered itself chose its own name, which the page says proves nothing.
 */
const whoAsks = (h: Html.HtmlBuilder<Message>, language: Language, request: ConnectRequest) => {
  const name = request.client.name ?? say(language, 'connect.unnamed')
  return h.div(styled(h, s.section()), [
    h.h2(styled(h, s.rowTitle()), [format(language, 'connect.asks', { client: name })]),
    h.p(styled(h, s.meta()), [
      request.client.publisher === null
        ? say(language, 'connect.unverified')
        : format(language, 'connect.publishedBy', { publisher: request.client.publisher }),
    ]),
    Ui.facts(h, [
      Ui.fact(
        h,
        say(language, 'connect.sendsTo'),
        h.span(
          [],
          [
            Ui.dataText(h, request.redirect.host),
            request.redirect.loopback ? Ui.chip(h, say(language, 'connect.thisDevice')) : h.empty,
          ],
        ),
      ),
      Ui.fact(h, say(language, 'connect.resource'), Ui.dataText(h, request.resource)),
      Ui.fact(h, say(language, 'connect.until'), formatInstant(request.expiresAt, language)),
    ]),
  ])
}

const grantText = (language: Language, agent: Agent) => {
  if (agent.revoked) return say(language, 'agents.revoked')
  return Option.match(Option.fromNullishOr(agent.grant), {
    onNone: () => say(language, 'agents.noGrant'),
    onSome: (grant) =>
      format(language, 'agents.grantSummary', {
        scopes: grant.scopes.map((scope) => scopeLabel(language, scope)).join(', '),
        date: formatInstant(grant.expiresAt, language),
      }),
  })
}

const agentChoice = (h: Html.HtmlBuilder<Message>, model: Model, request: ConnectRequest, agent: Agent) => {
  const id = `connect-agent-${agent.id}`
  const enabled = pickable(agent, request.expiresAt)
  return h.keyed('div')(agent.id, styled(h, as.scope()), [
    h.input([
      h.Id(id),
      h.Type('radio'),
      h.Name('agent'),
      h.Value(agent.id),
      h.Disabled(!enabled),
      h.Checked(Option.contains(model.maybeAgent, agent.id)),
      h.AriaDescribedBy(`${id}-grant`),
      h.OnChange(() => Message.PickedAgent({ agent: agent.id })),
    ]),
    h.span(
      [],
      [
        h.label([h.For(id), ...styled(h, s.label())], [agent.name]),
        h.span([h.Id(`${id}-grant`), ...styled(h, s.hint())], [grantText(model.language, agent)]),
      ],
    ),
  ])
}

const agentPicker = (h: Html.HtmlBuilder<Message>, model: Model, request: ConnectRequest) =>
  h.fieldset(styled(h, s.choices()), [
    h.legend(styled(h, s.legend()), [say(model.language, 'connect.pickAgent')]),
    AsyncData.matchData(model.agents, {
      onEmpty: () => Ui.waiting(h, say(model.language, 'agents.loading')),
      onFailure: (problem) => Ui.problemNotice(h, model.language, problem),
      onData: (agents) =>
        Array.match(agents, {
          onEmpty: () => h.p(styled(h, s.meta()), [say(model.language, 'connect.noAgents')]),
          onNonEmpty: (items) =>
            h.div(
              [],
              items.map((agent) => agentChoice(h, model, request, agent)),
            ),
        }),
    }),
    h.p(styled(h, s.hint()), [h.a([h.Href(agentsRouter())], [say(model.language, 'connect.manageAgents')])]),
  ])

const decision = (h: Html.HtmlBuilder<Message>, model: Model) => {
  const sending = Answer.guards.Sending(model.answer)
  return h.div(styled(h, s.section()), [
    Answer.guards.Failed(model.answer) ? Ui.problemNotice(h, model.language, model.answer.problem) : h.empty,
    Answer.guards.Sent(model.answer)
      ? Ui.waiting(h, say(model.language, 'connect.leaving'))
      : h.div(styled(h, s.actions()), [
          Ui.button(h, {
            label: say(model.language, 'connect.allow'),
            onClick: Message.ClickedAllow(),
            kind: 'primary',
            busy: sending,
            disabled: Option.isNone(model.maybeAgent),
          }),
          Ui.button(h, {
            label: say(model.language, 'connect.refuse'),
            onClick: Message.ClickedRefuse(),
            busy: sending,
          }),
        ]),
  ])
}

const asked = (h: Html.HtmlBuilder<Message>, model: Model) =>
  Asking.match(model.asking, {
    Reading: () => Ui.waiting(h, say(model.language, 'connect.reading')),
    Gone: () => Ui.notice(h, 'neutral', [h.p([], [say(model.language, 'connect.gone')])]),
    Failed: ({ problem }) => Ui.problemNotice(h, model.language, problem),
    Shown: ({ request }) =>
      h.section(
        [h.AriaLabel(say(model.language, 'connect.title')), ...styled(h, s.panel())],
        [whoAsks(h, model.language, request), agentPicker(h, model, request), decision(h, model)],
      ),
  })

/** The consent page: who asks, where the access goes, which agent it acts as; allow or refuse. */
export const view = Submodel.defineView<Model, Message, { readonly session: Session }>((model, { session }, h) =>
  h.div(styled(h, s.page()), [
    Ui.pageHead(h, say(model.language, 'connect.title'), [say(model.language, 'connect.lede')]),
    signedInOnly(h, { language: model.language, session, route: AppRoute.Connect({ request: model.request }) }, () =>
      asked(h, model),
    ),
  ]),
)
