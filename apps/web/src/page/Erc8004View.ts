import { format } from '@sidequest/i18n'
import type { Erc8004Failure, Erc8004Identity } from '@sidequest/protocol'
import { Array, Option } from 'effect'
import { type Html, Submodel } from 'foldkit'
import type { Language } from '../Language.ts'
import { publishFailureNotice } from '../Publishing.ts'
import { AppRoute, identityHref } from '../route.ts'
import { styled } from '../Styled.ts'
import { type PlainKey, say } from '../Text.ts'
import * as Ui from '../Ui.ts'
import * as s from '../Ui.styles.ts'
import { agentOf, Flow, identityRegistryOf, Message, type Model, RegistrationFailure, summaryOf } from './Erc8004.ts'

// One agent on ERC-8004: its identities as the index verified them, its counted reviews in short, and registering it
// with the person's wallet.

/** The key the section is about: one of the person's agents, or the person themselves. */
type Inputs = {
  readonly agent: string
  readonly maybeMcp: Option.Option<string>
  readonly kind: 'agent' | 'person'
}

const failureKeys: Readonly<Record<Erc8004Failure, PlainKey>> = {
  noToken: 'erc8004.failure.noToken',
  ownerNotLinked: 'erc8004.failure.ownerNotLinked',
  notGranted: 'erc8004.failure.notGranted',
  otherUri: 'erc8004.failure.otherUri',
}

const identityLine = (h: Html.HtmlBuilder<Message>, language: Language, identity: Erc8004Identity) => {
  const id = { id: identity.agentId }
  return h.keyed('li')(
    `${identity.registry}/${identity.agentId}`,
    [],
    [
      identity.status === 'verified'
        ? Ui.chip(h, format(language, 'erc8004.verified', id), 'done')
        : Ui.chip(h, format(language, 'erc8004.claimed', id)),
      identity.status === 'unchecked'
        ? h.span(styled(h, s.hint()), [say(language, 'erc8004.unchecked')])
        : Option.match(Option.fromNullishOr(identity.failure), {
            onNone: () => h.empty,
            onSome: (failure) => h.span(styled(h, s.hint()), [say(language, failureKeys[failure])]),
          }),
    ],
  )
}

const feedbackLine = (h: Html.HtmlBuilder<Message>, language: Language, count: number, average: number | null) =>
  h.p(styled(h, s.meta()), [
    format(language, 'erc8004.feedback', {
      count,
      average: average === null ? '' : average.toFixed(1),
    }),
  ])

const flowNotice = (h: Html.HtmlBuilder<Message>, language: Language, flow: Flow) =>
  Flow.match(flow, {
    Closed: () => h.empty,
    Connecting: () => Ui.waiting(h, say(language, 'erc8004.waitingWallet')),
    Preparing: () => Ui.waiting(h, say(language, 'erc8004.waitingWallet')),
    Sending: () => Ui.waiting(h, say(language, 'erc8004.waitingWallet')),
    Mining: () => Ui.waiting(h, say(language, 'erc8004.mining')),
    Claiming: () => Ui.waiting(h, say(language, 'erc8004.claiming')),
    Claimed: ({ agentId }) => Ui.notice(h, 'done', [h.p([], [format(language, 'erc8004.done', { id: agentId })])]),
    Failed: ({ failure }) =>
      RegistrationFailure.match(failure, {
        Claim: ({ failure: claim }) => publishFailureNotice(h, language, claim, identityHref(AppRoute.Agents())),
        NotMinted: () => Ui.notice(h, 'danger', [h.p([], [say(language, 'erc8004.notMinted')])]),
        Failed: ({ problem }) => Ui.problemNotice(h, language, problem),
      }),
  })

const registerControl = (h: Html.HtmlBuilder<Message>, model: Model, inputs: Inputs, verified: boolean) => {
  const language = model.language
  const working = !Flow.guards.Closed(model.flow) && !Flow.guards.Claimed(model.flow) && !Flow.guards.Failed(model.flow)
  return verified || Option.isNone(identityRegistryOf(model))
    ? h.empty
    : h.div(styled(h, s.section()), [
        h.p(styled(h, s.hint()), [
          say(language, inputs.kind === 'agent' ? 'erc8004.registerHint' : 'erc8004.registerSelfHint'),
        ]),
        h.div(styled(h, s.actions()), [
          Ui.button(h, {
            label: say(language, 'erc8004.register'),
            onClick: Message.ClickedRegister({ agent: inputs.agent, maybeMcp: inputs.maybeMcp }),
            busy: working,
          }),
        ]),
      ])
}

export const view = Submodel.defineView<Model, Message, Inputs>((model, inputs, h) => {
  const language = model.language
  const summary = summaryOf(model, inputs.agent)
  const identities = Option.match(summary, { onNone: () => [], onSome: ({ identities: found }) => found })
  const verified = Array.some(identities, (identity) => identity.status === 'verified')
  const ours = Option.contains(agentOf(model.flow), inputs.agent)
  return h.section(
    [h.AriaLabel(say(language, 'erc8004.title')), ...styled(h, s.section())],
    [
      h.h3([], [say(language, 'erc8004.title')]),
      Array.match(identities, {
        onEmpty: () => h.p(styled(h, s.meta()), [say(language, 'erc8004.none')]),
        onNonEmpty: (found) =>
          h.ul(
            styled(h, s.rows()),
            found.map((identity) => identityLine(h, language, identity)),
          ),
      }),
      Option.match(summary, {
        onNone: () => h.empty,
        onSome: ({ count, averageRating }) => feedbackLine(h, language, count, averageRating),
      }),
      registerControl(h, model, inputs, verified),
      ours ? flowNotice(h, language, model.flow) : h.empty,
    ],
  )
})
