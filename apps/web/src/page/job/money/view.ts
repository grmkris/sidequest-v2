import { format } from '@sidequest/i18n'
import type { FundingView, JobView, ProposalView } from '@sidequest/fold'
import { type EscrowRefusalReason, NetworkRef } from '@sidequest/protocol'
import { Array, Option, Schema } from 'effect'
import { type Html, Submodel } from 'foldkit'
import { formatAmount } from '../../../Amount.ts'
import { FormStatus, shown } from '../../../Forms.ts'
import type { Language } from '../../../Language.ts'
import { type Me, pubkeyOf, walletOn } from '../../../Me.ts'
import { type Names, nameOf } from '../../../Names.ts'
import { publishFailureNotice } from '../../../Publishing.ts'
import { styled } from '../../../Styled.ts'
import { formatInstant, type PlainKey, say } from '../../../Text.ts'
import * as Ui from '../../../Ui.ts'
import * as s from '../../../Ui.styles.ts'
import { fundingSlip, switchPrompt } from './slip.ts'
import * as js from '../Job.styles.ts'
import { addressOf, Flow, Message, type Model, MoneyFailure, type Step, stepOf } from './message.ts'

// The money panel: the step it is the person's turn to sign, and where a step in flight stands. Only the job's buyer,
// its worker and a bidder whose proposal the buyer accepted see it.

export type MoneyInputs = {
  readonly job: JobView
  readonly me: Me
  readonly names: Names
  readonly timeZone: string
  /** The identity page, coming back to this job. */
  readonly identityHref: string
}

type Reader = MoneyInputs & { readonly language: Language; readonly model: Model }
type H = Html.HtmlBuilder<Message>

const stepKeys: Readonly<Record<Step, PlainKey>> = {
  fund: 'money.step.fund',
  deliver: 'money.step.deliver',
  approve: 'money.step.approve',
  reject: 'money.step.reject',
}

const doneKeys: Readonly<Record<Step, PlainKey>> = {
  fund: 'money.done.fund',
  deliver: 'money.done.deliver',
  approve: 'money.done.approve',
  reject: 'money.done.reject',
}

/** Every refusal of the escrow, in one plain sentence. */
export const refusalKeys: Readonly<Record<EscrowRefusalReason, PlainKey>> = {
  RequestNotIndexed: 'money.refused.requestNotIndexed',
  ProposalNotIndexed: 'money.refused.proposalNotIndexed',
  ProposalForOtherBuyer: 'money.refused.proposalForOtherBuyer',
  ReceiverNotPayTo: 'money.refused.receiverNotPayTo',
  PayerNotLinked: 'money.refused.payerNotLinked',
  ProposalExpired: 'money.refused.proposalExpired',
  ProposalWithdrawn: 'money.refused.proposalWithdrawn',
  ProposalSuperseded: 'money.refused.proposalSuperseded',
  AlreadyFunded: 'money.refused.alreadyFunded',
  NotFunded: 'money.refused.notFunded',
  NotDelivered: 'money.refused.notDelivered',
  Unpayable: 'money.refused.unpayable',
  ChainRefused: 'money.refused.chainRefused',
}

/** The refusals the job as read no longer explains: reading it again shows what changed. */
const readAgainReasons: ReadonlyArray<EscrowRefusalReason> = [
  'ProposalNotIndexed',
  'ProposalExpired',
  'ProposalWithdrawn',
  'ProposalSuperseded',
  'AlreadyFunded',
  'NotFunded',
  'NotDelivered',
]

const progress = (h: H, language: Language, step: Step, key: PlainKey) =>
  Ui.notice(h, 'neutral', [h.p([h.AriaBusy(true)], [say(language, stepKeys[step]), ': ', say(language, key)])])

const transaction = (h: H, language: Language, hash: string) =>
  h.p(styled(h, s.meta()), [say(language, 'money.transaction'), ' ', Ui.dataText(h, hash)])

const refusedNotice = (h: H, reader: Reader, reason: EscrowRefusalReason, maybeDetail: Option.Option<string>) => {
  const language = reader.language
  return Ui.notice(h, 'danger', [
    h.p([], [say(language, refusalKeys[reason])]),
    Option.match(reason === 'ChainRefused' ? maybeDetail : Option.none(), {
      onNone: () => h.empty,
      onSome: (detail) => h.p(styled(h, s.meta()), [say(language, 'money.chainSaid'), ' ', Ui.dataText(h, detail)]),
    }),
    reason === 'PayerNotLinked'
      ? h.p([], [h.a([h.Href(reader.identityHref)], [say(language, 'money.linkWallet')])])
      : h.empty,
    readAgainReasons.includes(reason)
      ? h.div(styled(h, s.actions()), [
          Ui.button(h, { label: say(language, 'money.readAgain'), onClick: Message.ClickedReadAgain() }),
        ])
      : h.empty,
  ])
}

const failureNotice = (h: H, reader: Reader, step: Step, failure: MoneyFailure) => {
  const language = reader.language
  return h.div(styled(h, s.section()), [
    h.p(styled(h, s.rowTitle()), [format(language, 'money.stopped', { step: say(language, stepKeys[step]) })]),
    MoneyFailure.match(failure, {
      Refused: ({ reason, maybeDetail }) => refusedNotice(h, reader, reason, maybeDetail),
      RateLimited: ({ retryAfterSeconds }) =>
        Ui.notice(h, 'danger', [h.p([], [format(language, 'money.rateLimited', { seconds: retryAfterSeconds })])]),
      NotIndexed: () => Ui.notice(h, 'danger', [h.p([], [say(language, 'money.notIndexed')])]),
      Unpublished: ({ failure: unpublished }) => publishFailureNotice(h, language, unpublished, reader.identityHref),
      Failed: ({ problem }) => Ui.problemNotice(h, language, problem),
    }),
  ])
}

const wrongWallet = (h: H, language: Language, signer: string, connected: string) =>
  Ui.notice(h, 'danger', [
    h.p([], [say(language, 'money.wrongWallet')]),
    Ui.facts(h, [
      Ui.fact(h, say(language, 'money.connected'), Ui.dataText(h, connected)),
      Ui.fact(h, say(language, 'money.needed'), Ui.dataText(h, signer)),
    ]),
    h.div(styled(h, s.actions()), [
      Ui.button(h, { label: say(language, 'common.tryAgain'), onClick: Message.ClickedTryAgain(), kind: 'primary' }),
      Ui.button(h, { label: say(language, 'common.cancel'), onClick: Message.ClickedCancel() }),
    ]),
  ])

const cancelButton = (h: H, language: Language) =>
  Ui.button(h, { label: say(language, 'common.cancel'), onClick: Message.ClickedCancel() })

const deliveryForm = (h: H, language: Language, flow: Extract<Flow, { readonly _tag: 'EditingDelivery' }>) =>
  h.form(
    [h.OnSubmit(Message.SubmittedDelivery()), h.Novalidate(true), ...styled(h, s.form())],
    [
      h.p([], [say(language, 'money.deliverIntro')]),
      Ui.textField(h, {
        id: 'delivery-url',
        label: say(language, 'money.deliveryUrl'),
        hint: say(language, 'money.deliveryUrlHint'),
        type: 'url',
        inputMode: 'url',
        value: flow.url,
        onInput: (value) => Message.UpdatedDeliveryUrl({ value }),
        error: shown(flow.status, Option.some(say(language, 'money.deliveryInvalid'))),
      }),
      Ui.textArea(h, {
        id: 'delivery-note',
        label: say(language, 'money.deliveryNote'),
        hint: say(language, 'money.deliveryNoteHint'),
        value: flow.note,
        onInput: (value) => Message.UpdatedDeliveryNote({ value }),
      }),
      h.div(styled(h, s.actions()), [
        Ui.submit(h, { label: say(language, 'money.signDelivery'), busy: false }),
        cancelButton(h, language),
      ]),
    ],
  )

const approvalSlip = (h: H, language: Language) =>
  h.div(
    [h.Role('group'), h.AriaLabel(say(language, 'money.approveLabel')), ...styled(h, js.slip())],
    [
      h.p([], [say(language, 'money.approveExplain')]),
      h.div(styled(h, s.actions()), [
        Ui.button(h, {
          label: say(language, 'money.signApproval'),
          onClick: Message.ClickedConfirmApproval(),
          kind: 'seal',
        }),
        cancelButton(h, language),
      ]),
    ],
  )

const rejectionForm = (h: H, language: Language, reason: string, status: FormStatus) =>
  h.form(
    [h.OnSubmit(Message.SubmittedRejection()), h.Novalidate(true), ...styled(h, s.form())],
    [
      h.p([], [say(language, 'money.rejectExplain')]),
      Ui.textArea(h, {
        id: 'rejection-reason',
        label: say(language, 'money.reason'),
        hint: say(language, 'money.reasonHint'),
        value: reason,
        onInput: (value) => Message.UpdatedReason({ value }),
        error: shown(status, Option.some(format(language, 'money.reasonInvalid', { max: 4000 }))),
        required: true,
      }),
      h.div(styled(h, s.actions()), [
        Ui.submit(h, { label: say(language, 'money.signRejection'), busy: false, kind: 'destructive' }),
        cancelButton(h, language),
      ]),
    ],
  )

const following = (h: H, language: Language, step: Step, transactionHash: string, gaveUp: boolean) =>
  Ui.notice(h, 'neutral', [
    h.p([], [say(language, stepKeys[step]), ': ', say(language, 'money.sent')]),
    transaction(h, language, transactionHash),
    gaveUp
      ? h.div(styled(h, s.section()), [
          h.p([], [say(language, 'money.notYet')]),
          h.div(styled(h, s.actions()), [
            Ui.button(h, { label: say(language, 'money.checkAgain'), onClick: Message.ClickedCheckAgain() }),
          ]),
        ])
      : h.p([h.AriaBusy(true), ...styled(h, s.meta())], [say(language, 'money.checking')]),
  ])

/** A step the person is filling in or one in flight, if there is one; `stage` is what shows otherwise. */
const flowView = (h: H, reader: Reader, stage: () => Html.Html): Html.Html => {
  const { language, timeZone } = reader
  return Flow.match(reader.model.flow, {
    Idle: stage,
    EditingDelivery: (flow) => deliveryForm(h, language, flow),
    ConfirmingApproval: () => approvalSlip(h, language),
    EditingRejection: ({ reason, status }) => rejectionForm(h, language, reason, status),
    Connecting: ({ attempt }) => progress(h, language, stepOf(attempt.work), 'money.progress.connecting'),
    WrongWallet: ({ attempt, connected }) => wrongWallet(h, language, attempt.signer, connected),
    Publishing: ({ connected }) => progress(h, language, stepOf(connected.work), 'money.progress.publishing'),
    Preparing: ({ connected }) => progress(h, language, stepOf(connected.work), 'money.progress.preparing'),
    Ready: ({ prepared }) =>
      Option.match(prepared.maybeFunding, {
        onNone: () => switchPrompt(h, language, prepared.connection.chainId),
        onSome: (funding) => fundingSlip(h, { language, timeZone, funding, walletChain: prepared.connection.chainId }),
      }),
    Switching: ({ prepared }) => progress(h, language, stepOf(prepared.work), 'money.progress.switching'),
    Signing: ({ prepared }) => progress(h, language, stepOf(prepared.work), 'money.progress.signing'),
    Submitting: ({ step }) => progress(h, language, step, 'money.progress.submitting'),
    Following: ({ step, transactionHash }) => following(h, language, step, transactionHash, false),
    GaveUp: ({ step, transactionHash }) => following(h, language, step, transactionHash, true),
    Done: ({ step, transactionHash }) =>
      h.div(styled(h, s.section()), [
        Ui.notice(h, 'done', [h.p([], [say(language, doneKeys[step])]), transaction(h, language, transactionHash)]),
        stage(),
      ]),
    Failed: ({ step, failure }) => h.div(styled(h, s.section()), [failureNotice(h, reader, step, failure), stage()]),
  })
}

// WHOSE TURN

const isMine = (reader: Reader, pubkey: string | null) =>
  pubkey !== null && Option.contains(pubkeyOf(reader.me), pubkey)

/** The proposal from the person the buyer accepted, still standing and not yet funded. */
const acceptedOf = (view: JobView): Option.Option<ProposalView> =>
  Array.findFirst(
    view.proposals,
    (proposal) => proposal.accepted && !proposal.superseded && !proposal.withdrawn && !proposal.expired,
  )

const linkFirst = (h: H, reader: Reader, key: PlainKey) =>
  Ui.notice(h, 'neutral', [
    h.p([], [say(reader.language, key)]),
    h.p([], [h.a([h.Href(reader.identityHref)], [say(reader.language, 'money.linkWallet')])]),
  ])

const buyerBeforeFunding = (h: H, reader: Reader) => {
  const { job, language, names } = reader
  return Option.match(acceptedOf(job), {
    onNone: () => h.p([], [say(language, 'money.fundAny')]),
    onSome: (proposal) =>
      Option.match(Option.flatMap(walletOn(reader.me, proposal.content.terms.network), addressOf), {
        onNone: () => linkFirst(h, reader, 'money.fundNeedsLink'),
        onSome: (payer) =>
          h.div(styled(h, s.section()), [
            h.p(
              [],
              [
                format(language, 'money.fundIntro', {
                  bidder: nameOf(names, proposal.author),
                  amount: formatAmount(proposal.content.terms.amount, proposal.content.terms.asset, language),
                }),
              ],
            ),
            h.div(styled(h, s.actions()), [
              Ui.button(h, {
                label: say(language, 'money.reviewFunding'),
                onClick: Message.ClickedFund({ proposal: proposal.id, payer }),
                kind: 'primary',
              }),
            ]),
          ]),
      }),
  })
}

/** The CAIP-2 network of a CAIP-10 account (`eip155:5042002` of `eip155:5042002:0x…`). */
const networkOf = (account: string) => Schema.decodeUnknownOption(NetworkRef)(account.split(':').slice(0, 2).join(':'))

const fundedView = (h: H, reader: Reader, funding: FundingView) => {
  const { job, language, timeZone } = reader
  const deadline = formatInstant(funding.fact.deliveryDeadline, language, timeZone)
  if (isMine(reader, job.buyer)) {
    return h.p([], [format(language, 'money.waitingDelivery', { date: deadline })])
  }
  if (job.deadlines.deliveryOverdue) {
    return h.p([], [say(language, 'money.overdue')])
  }
  const receiver = funding.fact.receiver
  return Option.match(Option.all({ signer: addressOf(receiver), network: networkOf(receiver) }), {
    onNone: () => h.empty,
    onSome: ({ signer, network }) =>
      h.div(styled(h, s.section()), [
        h.p([], [format(language, 'money.deliverBy', { date: deadline })]),
        h.div(styled(h, s.actions()), [
          Ui.button(h, {
            label: say(language, 'money.deliver'),
            onClick: Message.ClickedDeliver({ signer, buyer: job.buyer, network }),
            kind: 'primary',
          }),
        ]),
      ]),
  })
}

const deliveredView = (h: H, reader: Reader, funding: FundingView) => {
  const { job, language } = reader
  if (!isMine(reader, job.buyer)) {
    return h.p([], [say(language, 'money.waitingReview')])
  }
  if (!job.deadlines.reviewWindowOpen) {
    return h.p([], [say(language, 'money.reviewOver')])
  }
  return Option.match(addressOf(funding.fact.payer), {
    onNone: () => h.empty,
    onSome: (signer) =>
      h.div(styled(h, s.actions()), [
        Ui.button(h, {
          label: say(language, 'money.approve'),
          onClick: Message.ClickedApprove({ signer }),
          kind: 'primary',
        }),
        Ui.button(h, {
          label: say(language, 'money.reject'),
          onClick: Message.ClickedReject({ signer }),
          kind: 'destructive',
        }),
      ]),
  })
}

/** The buyer may take the escrow back themselves once its authorization expired; the page names the contract. */
const reclaimNote = (h: H, reader: Reader) =>
  reader.job.deadlines.reclaimable && isMine(reader, reader.job.buyer)
    ? Ui.notice(h, 'neutral', [
        h.p([], [say(reader.language, 'money.reclaimable')]),
        Option.match(reader.model.maybePayment, {
          onNone: () => h.empty,
          onSome: (payment) =>
            h.p(styled(h, s.meta()), [say(reader.language, 'money.escrow'), ' ', Ui.dataText(h, payment.escrow)]),
        }),
      ])
    : h.empty

const stageView = (h: H, reader: Reader): Html.Html => {
  const { job, language } = reader
  const funding = job.funding
  if (funding === null) {
    if (job.stage === 'closed' || job.request.closedByBuyer) {
      return h.empty
    }
    return isMine(reader, job.buyer) ? buyerBeforeFunding(h, reader) : h.p([], [say(language, 'money.waitingFunding')])
  }
  const steps: Partial<Record<JobView['stage'], () => Html.Html>> = {
    funded: () => fundedView(h, reader, funding),
    delivered: () => deliveredView(h, reader, funding),
  }
  return h.div(styled(h, s.section()), [steps[job.stage]?.() ?? h.empty, reclaimNote(h, reader)])
}

/** Whether the person has a part in the job's money: its buyer, its worker, or the bidder the buyer accepted. */
const isParty = (job: JobView, me: Me): boolean => {
  const mine = (pubkey: string | null) => pubkey !== null && Option.contains(pubkeyOf(me), pubkey)
  return (
    mine(job.buyer) ||
    mine(job.worker) ||
    (job.funding === null && Array.some(job.proposals, (proposal) => proposal.accepted && mine(proposal.author)))
  )
}

/** Stages where a party may have a step to sign; after a rejection or an ending the panel has nothing to offer. */
const stepStages: ReadonlySet<JobView['stage']> = new Set(['open', 'proposed', 'accepted', 'funded', 'delivered'])

/** The panel shows for a party while a step may be theirs, while one is in flight or just ended, and while the buyer
 * may reclaim. */
export const panelShown = (model: Model, job: JobView, me: Me): boolean =>
  isParty(job, me) && (stepStages.has(job.stage) || job.deadlines.reclaimable || !Flow.guards.Idle(model.flow))

export const view = Submodel.defineView<Model, Message, MoneyInputs>((model, inputs, h) => {
  const reader: Reader = { ...inputs, model, language: model.language }
  return h.section(
    [h.AriaLabelledBy('job-money'), ...styled(h, s.panel())],
    [h.h2([h.Id('job-money')], [say(model.language, 'money.title')]), flowView(h, reader, () => stageView(h, reader))],
  )
})
