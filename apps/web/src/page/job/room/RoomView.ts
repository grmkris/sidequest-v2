import { format } from '@sidequest/i18n'
import { Array, Option } from 'effect'
import { type Html, Submodel } from 'foldkit'
import { cx } from 'zyzz'
import { formatAmount } from '../../../Amount.ts'
import type { Language } from '../../../Language.ts'
import { type Names, nameOf } from '../../../Names.ts'
import type { RoomLine, RoomsFailure, RoomSnapshot } from '../../../Rooms.ts'
import { evidenceRouter } from '../../../route.ts'
import { styled } from '../../../Styled.ts'
import { formatInstant, type PlainKey, say } from '../../../Text.ts'
import * as Ui from '../../../Ui.ts'
import * as s from '../../../Ui.styles.ts'
import { Evidence, maxMessageLength, Message, type Model, Panel, selectedRoom, Sending, type Target } from './Room.ts'
import * as rs from './Room.styles.ts'

// The room panel. Every message is shown as plain text: never HTML, never Markdown, and a link in it is only text, so
// nothing a member writes makes the page fetch anything.

/** What the job page tells the panel: whose rooms it would open, who the person is, the names it knows. */
export type ViewInputs = {
  readonly maybeTarget: Option.Option<Target>
  readonly me: string
  readonly names: Names
  readonly timeZone: string
  readonly identityHref: string
  /** The site has default inbox relays to offer on the identity page. */
  readonly inboxConfigured: boolean
}

type Reader = ViewInputs & { readonly model: Model; readonly language: Language }

const problemKeys: Readonly<Record<RoomsFailure, PlainKey>> = {
  locked: 'room.unavailable.locked',
  noNip44: 'room.unavailable.noNip44',
  notLoaded: 'room.unavailable.notLoaded',
  notMember: 'room.problem.notMember',
  badBody: 'room.problem.badBody',
  cannotDisclose: 'room.problem.cannotDisclose',
  signerRefused: 'room.problem.signerRefused',
  failed: 'room.problem.failed',
}

const problem = (h: Html.HtmlBuilder<Message>, language: Language, reason: RoomsFailure) =>
  Ui.notice(h, 'danger', [h.p([], [say(language, problemKeys[reason])])])

const who = (reader: Reader, pubkey: string) =>
  pubkey === reader.me ? say(reader.language, 'room.you') : nameOf(reader.names, pubkey)

/** What a line says, as text. */
const lineText = (reader: Reader, line: RoomLine): string => {
  const member = Option.getOrElse(line.maybeMember, () => '')
  const author = who(reader, line.author)
  if (line.act === 'add') return format(reader.language, 'room.added', { author, member: who(reader, member) })
  if (line.act === 'remove') return format(reader.language, 'room.removed', { author, member: who(reader, member) })
  if (line.act === 'text') return line.text
  return Option.match(line.maybeProposal, {
    onNone: () => say(reader.language, 'room.unreadableProposal'),
    onSome: (proposal) =>
      format(reader.language, 'room.privateProposal', {
        title: proposal.title,
        amount: formatAmount(proposal.amount, proposal.asset, reader.language),
      }),
  })
}

const discloseControl = (h: Html.HtmlBuilder<Message>, reader: Reader, room: string, line: RoomLine) => {
  const evidence = reader.model.evidence
  if (line.act !== 'text' || !Option.exists(reader.model.maybeRead, (read) => read.canDisclose)) return h.empty
  if (Evidence.guards.Preparing(evidence) && evidence.message === line.id) {
    return Ui.waiting(h, say(reader.language, 'room.preparing'))
  }
  return Ui.linkButton(h, say(reader.language, 'room.disclose'), Message.ClickedDisclose({ room, message: line.id }))
}

const lineView = (h: Html.HtmlBuilder<Message>, reader: Reader, room: string, line: RoomLine) =>
  h.keyed('li')(line.id, styled(h, line.author === reader.me ? cx(rs.line(), rs.mine()) : rs.line()), [
    h.p(styled(h, s.meta()), [
      who(reader, line.author),
      ' · ',
      formatInstant(line.createdAt, reader.language, reader.timeZone),
      ' ',
      line.viaGateway ? Ui.chip(h, say(reader.language, 'room.viaGateway'), 'seal') : h.empty,
    ]),
    h.p(styled(h, rs.text()), [lineText(reader, line)]),
    discloseControl(h, reader, room, line),
  ])

const evidenceView = (h: Html.HtmlBuilder<Message>, reader: Reader) =>
  Evidence.match(reader.model.evidence, {
    None: () => h.empty,
    Preparing: () => h.empty,
    Failed: ({ reason }) => problem(h, reader.language, reason),
    Ready: ({ message: id, json }) =>
      Ui.notice(h, 'done', [
        h.p([], [say(reader.language, 'room.evidenceReady')]),
        h.div(styled(h, s.actions()), [
          h.a(
            [
              h.Href(`data:application/json;charset=utf-8,${encodeURIComponent(json)}`),
              h.Download(`sidequest-evidence-${id.slice(0, 12)}.json`),
            ],
            [say(reader.language, 'room.download')],
          ),
          h.a([h.Href(evidenceRouter())], [say(reader.language, 'room.checkEvidence')]),
          Ui.linkButton(h, say(reader.language, 'common.close'), Message.ClickedCloseEvidence()),
        ]),
        h.pre(styled(h, rs.bundle()), [json]),
      ]),
  })

const agentNotices = (h: Html.HtmlBuilder<Message>, reader: Reader, snapshot: RoomSnapshot) =>
  Array.map(snapshot.agents, (agent) =>
    Ui.notice(h, 'neutral', [
      h.p(
        [],
        [format(reader.language, 'room.agent', { name: nameOf(reader.names, agent.pubkey), label: agent.label })],
      ),
    ]),
  )

const composer = (h: Html.HtmlBuilder<Message>, reader: Reader) => {
  const { model, language } = reader
  const count = (model.draft.match(/./gsu) ?? []).length
  return h.form(
    [h.OnSubmit(Message.SubmittedMessage()), ...styled(h, s.form())],
    [
      h.label([h.For('room-message'), ...styled(h, s.label())], [say(language, 'room.messageLabel')]),
      h.textarea([
        h.Id('room-message'),
        h.Name('room-message'),
        h.Value(model.draft),
        h.OnInput((value) => Message.UpdatedDraft({ value })),
        h.Maxlength(maxMessageLength),
        h.Rows(3),
        ...styled(h, cx(s.input(), s.textArea())),
      ]),
      h.p(styled(h, s.hint()), [format(language, 'room.count', { count, limit: maxMessageLength })]),
      h.div(styled(h, s.actions()), [
        Ui.submit(h, { label: say(language, 'room.send'), busy: Sending.guards.Sending(model.sending) }),
        Sending.match(model.sending, {
          Writing: () => h.empty,
          Sending: () => Ui.waiting(h, say(language, 'room.sending')),
          Sent: ({ delivered }) => h.p(styled(h, s.meta()), [format(language, 'room.sent', delivered)]),
          Failed: ({ reason }) => problem(h, language, reason),
        }),
      ]),
    ],
  )
}

const forgetControls = (h: Html.HtmlBuilder<Message>, reader: Reader, room: string) =>
  Option.contains(reader.model.maybeForgetting, room)
    ? Ui.notice(h, 'neutral', [
        h.p([], [say(reader.language, 'room.forgetConfirm')]),
        h.div(styled(h, s.actions()), [
          Ui.button(h, {
            label: say(reader.language, 'room.forget'),
            onClick: Message.ClickedConfirmForget(),
            kind: 'destructive',
          }),
          Ui.button(h, { label: say(reader.language, 'room.keep'), onClick: Message.ClickedKeep() }),
        ]),
      ])
    : h.div(styled(h, s.actions()), [
        Ui.linkButton(h, say(reader.language, 'room.forget'), Message.ClickedForget({ room })),
      ])

const roomView = (h: Html.HtmlBuilder<Message>, reader: Reader, snapshot: RoomSnapshot) =>
  h.div(styled(h, s.section()), [
    ...agentNotices(h, reader, snapshot),
    Array.match(snapshot.lines, {
      onEmpty: () => h.p(styled(h, s.meta()), [say(reader.language, 'room.empty')]),
      onNonEmpty: (lines) =>
        h.ol(
          [h.AriaLabel(say(reader.language, 'room.messages')), ...styled(h, rs.transcript())],
          Array.map(lines, (line) => lineView(h, reader, snapshot.room, line)),
        ),
    }),
    Option.exists(reader.model.maybeRead, (read) => read.canDisclose)
      ? h.empty
      : h.p(styled(h, s.meta()), [say(reader.language, 'room.cannotDisclose')]),
    snapshot.dropped > 0
      ? h.p(styled(h, s.meta()), [format(reader.language, 'room.dropped', { count: snapshot.dropped })])
      : h.empty,
    evidenceView(h, reader),
    composer(h, reader),
    forgetControls(h, reader, snapshot.room),
  ])

const roomChoices = (h: Html.HtmlBuilder<Message>, reader: Reader, rooms: ReadonlyArray<RoomSnapshot>, shown: string) =>
  rooms.length < 2
    ? h.empty
    : h.div(
        [h.Role('group'), h.AriaLabel(say(reader.language, 'room.conversations')), ...styled(h, rs.roomChoices())],
        Array.map(rooms, (snapshot) =>
          Ui.button(h, {
            label: format(reader.language, 'room.with', { name: nameOf(reader.names, snapshot.bidder) }),
            onClick: Message.SelectedRoom({ room: snapshot.room }),
            kind: snapshot.room === shown ? 'primary' : 'secondary',
          }),
        ),
      )

const relaysView = (h: Html.HtmlBuilder<Message>, reader: Reader) =>
  Option.match(reader.model.maybeRead, {
    onNone: () => h.empty,
    onSome: (read) =>
      h.p(styled(h, s.meta()), [
        say(reader.language, 'room.relays'),
        ' ',
        Array.map(read.relays, ({ relay, outcome }) =>
          format(
            reader.language,
            outcome === 'complete' || outcome === 'truncated' ? 'room.relayRead' : 'room.relayFailed',
            {
              relay: relay.replace(/^wss?:\/\//u, ''),
            },
          ),
        ).join(' · '),
      ]),
  })

const noInbox = (h: Html.HtmlBuilder<Message>, reader: Reader) =>
  Ui.notice(h, 'neutral', [
    h.p([], [say(reader.language, reader.inboxConfigured ? 'room.noInbox' : 'room.noInboxConfigured')]),
    reader.inboxConfigured
      ? h.p([], [h.a([h.Href(reader.identityHref)], [say(reader.language, 'room.setUpInbox')])])
      : h.empty,
  ])

const openPanel = (h: Html.HtmlBuilder<Message>, reader: Reader) =>
  Option.match(reader.model.maybeRead, {
    onNone: () => Ui.waiting(h, say(reader.language, 'room.opening')),
    onSome: (read) => {
      if (read.noInbox) return noInbox(h, reader)
      const shown = selectedRoom(reader.model)
      const snapshot = Array.findFirst(read.rooms, (held) => Option.contains(shown, held.room))
      return h.div(styled(h, s.section()), [
        roomChoices(
          h,
          reader,
          read.rooms,
          Option.getOrElse(shown, () => ''),
        ),
        Option.match(snapshot, {
          onNone: () => h.p(styled(h, s.meta()), [say(reader.language, 'room.noRooms')]),
          onSome: (held) => roomView(h, reader, held),
        }),
        relaysView(h, reader),
      ])
    },
  })

const panelBody = (h: Html.HtmlBuilder<Message>, reader: Reader) =>
  Panel.match(reader.model.panel, {
    Closed: () =>
      Option.match(reader.maybeTarget, {
        onNone: () => h.empty,
        onSome: (target) =>
          h.div(styled(h, s.actions()), [
            Ui.button(h, { label: say(reader.language, 'room.open'), onClick: Message.ClickedOpen({ target }) }),
          ]),
      }),
    Opening: () => Ui.waiting(h, say(reader.language, 'room.opening')),
    Unavailable: ({ reason }) => problem(h, reader.language, reason),
    Open: () =>
      h.div(styled(h, s.section()), [
        openPanel(h, reader),
        Option.match(reader.model.maybeProblem, {
          onNone: () => h.empty,
          onSome: (reason) => problem(h, reader.language, reason),
        }),
        h.div(styled(h, s.actions()), [Ui.linkButton(h, say(reader.language, 'room.close'), Message.ClickedClose())]),
      ]),
  })

export const view = Submodel.defineView<Model, Message, ViewInputs>((model, inputs, h) => {
  const reader: Reader = { ...inputs, model, language: model.language }
  return h.section(
    [h.AriaLabelledBy('job-room'), ...styled(h, s.panel())],
    [
      h.h2([h.Id('job-room')], [say(model.language, 'room.title')]),
      h.p(styled(h, s.meta()), [say(model.language, 'room.privacy')]),
      h.p(styled(h, s.meta()), [say(model.language, 'room.keptHere')]),
      panelBody(h, reader),
    ],
  )
})
