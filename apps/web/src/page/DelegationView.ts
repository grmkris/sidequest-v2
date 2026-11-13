import { format } from '@sidequest/i18n'
import { Array, Option } from 'effect'
import { AsyncData, type Html, Submodel } from 'foldkit'
import { dayChoices } from '../Forms.ts'
import { gatewayRefusalText } from '../Gateway.ts'
import type { Language } from '../Language.ts'
import { signerFailureText } from '../Publishing.ts'
import { styled } from '../Styled.ts'
import { formatInstant, say } from '../Text.ts'
import * as Ui from '../Ui.ts'
import * as s from '../Ui.styles.ts'
import { DelegationFailure, Flow, Message, type Model, type WorkerJob } from './Delegation.ts'
import { refusalKeys } from './job/money/view.ts'

// The delivery delegation for one agent: which job, for how long, and exactly what the wallet's signature allows.

type Inputs = { readonly agent: string; readonly label: string; readonly me: string; readonly timeZone: string }

const failureText = (language: Language, failure: DelegationFailure): string =>
  DelegationFailure.match(failure, {
    Gateway: ({ refusal }) => gatewayRefusalText(language, refusal),
    Core: ({ reason }) => say(language, refusalKeys[reason]),
    SignerFailed: ({ reason }) => signerFailureText(language, reason),
    Failed: () => '',
  })

const failureNotice = (h: Html.HtmlBuilder<Message>, language: Language, failure: DelegationFailure) =>
  DelegationFailure.guards.Failed(failure)
    ? Ui.problemNotice(h, language, failure.problem)
    : Ui.notice(h, 'danger', [h.p([], [failureText(language, failure)])])

/** What the signature allows and how it ends, in the person's words. */
const allows = (h: Html.HtmlBuilder<Message>, language: Language, label: string) =>
  h.div(styled(h, s.section()), [
    h.p([], [format(language, 'delegation.allows', { agent: label })]),
    h.p(styled(h, s.hint()), [say(language, 'delegation.revoke')]),
  ])

const jobOption = (language: Language, timeZone: string, job: WorkerJob) => ({
  value: job.job,
  label: format(language, 'delegation.jobOption', {
    title: job.title,
    date: formatInstant(job.deliveryDeadline, language, timeZone),
  }),
})

const chooseForm = (
  h: Html.HtmlBuilder<Message>,
  model: Model,
  inputs: Inputs,
  flow: Extract<Flow, { readonly _tag: 'Choosing' }>,
) => {
  const language = model.language
  return AsyncData.matchData(model.jobs, {
    onEmpty: () => Ui.waiting(h, say(language, 'delegation.loading')),
    onFailure: (problem) => Ui.problemNotice(h, language, problem),
    onData: (jobs) =>
      Array.match(jobs, {
        onEmpty: () =>
          h.div(styled(h, s.section()), [
            h.p(styled(h, s.meta()), [say(language, 'delegation.noJobs')]),
            Ui.button(h, { label: say(language, 'common.cancel'), onClick: Message.ClickedCancel() }),
          ]),
        onNonEmpty: (found) =>
          h.form(
            [h.OnSubmit(Message.SubmittedDelegation()), ...styled(h, s.form())],
            [
              Ui.selectField(h, {
                id: 'delegation-job',
                label: say(language, 'delegation.job'),
                value: Option.getOrElse(flow.maybeJob, () => ''),
                options: [
                  { value: '', label: say(language, 'delegation.pickJob') },
                  ...found.map((job) => jobOption(language, inputs.timeZone, job)),
                ],
                onChange: (job) => Message.SelectedJob({ job }),
              }),
              flow.invalid ? h.p(styled(h, s.fieldError()), [say(language, 'delegation.pickJob')]) : h.empty,
              Ui.selectField(h, {
                id: 'delegation-days',
                label: say(language, 'delegation.validFor'),
                value: flow.days,
                options: dayChoices.map((days) => ({
                  value: days,
                  label: format(language, 'form.days', { count: Number(days) }),
                })),
                onChange: (value) => Message.SelectedDays({ value }),
              }),
              allows(h, language, inputs.label),
              h.div(styled(h, s.actions()), [
                Ui.submit(h, { label: say(language, 'delegation.sign'), busy: false }),
                Ui.button(h, { label: say(language, 'common.cancel'), onClick: Message.ClickedCancel() }),
              ]),
            ],
          ),
      }),
  })
}

const flowView = (h: Html.HtmlBuilder<Message>, model: Model, inputs: Inputs) => {
  const language = model.language
  return Flow.match(model.flow, {
    Closed: () =>
      Ui.button(h, {
        label: say(language, 'delegation.open'),
        onClick: Message.ClickedDelegate({ agent: inputs.agent, pubkey: inputs.me }),
      }),
    Choosing: (flow) => chooseForm(h, model, inputs, flow),
    Connecting: () => Ui.waiting(h, say(language, 'delegation.connecting')),
    WrongWallet: ({ receiver, connected }) =>
      Ui.notice(h, 'danger', [
        h.p([], [say(language, 'delegation.wrongWallet')]),
        Ui.facts(h, [
          Ui.fact(h, say(language, 'money.connected'), Ui.dataText(h, connected)),
          Ui.fact(h, say(language, 'money.needed'), Ui.dataText(h, receiver)),
        ]),
        h.div(styled(h, s.actions()), [
          Ui.button(h, {
            label: say(language, 'common.tryAgain'),
            onClick: Message.ClickedTryAgain(),
            kind: 'primary',
          }),
          Ui.button(h, { label: say(language, 'common.cancel'), onClick: Message.ClickedCancel() }),
        ]),
      ]),
    Preparing: () => Ui.waiting(h, say(language, 'delegation.preparing')),
    Signing: () => Ui.waiting(h, say(language, 'delegation.signing')),
    Storing: () => Ui.waiting(h, say(language, 'delegation.storing')),
    Stored: ({ expiry }) =>
      Ui.notice(h, 'done', [
        h.p([], [format(language, 'delegation.stored', { date: formatInstant(expiry, language, inputs.timeZone) })]),
        h.p(styled(h, s.hint()), [say(language, 'delegation.revoke')]),
      ]),
    Failed: ({ failure }) =>
      h.div(styled(h, s.section()), [
        failureNotice(h, language, failure),
        h.div(styled(h, s.actions()), [
          Ui.button(h, { label: say(language, 'common.cancel'), onClick: Message.ClickedCancel() }),
        ]),
      ]),
  })
}

export const view = Submodel.defineView<Model, Message, Inputs>((model, inputs, h) =>
  Flow.guards.Closed(model.flow) || model.flow.agent === inputs.agent
    ? h.section(
        [h.AriaLabelledBy('agent-delegation'), ...styled(h, s.section())],
        [
          h.h3([h.Id('agent-delegation')], [say(model.language, 'delegation.title')]),
          h.p(styled(h, s.meta()), [say(model.language, 'delegation.lede')]),
          flowView(h, model, inputs),
        ],
      )
    : h.empty,
)
