import { format } from '@sidequest/i18n'
import type { AccountId, Message as RoomMessage, RoomRef } from '@sidequest/protocol'
import { Array, Option } from 'effect'
import { AsyncData, type Html, Submodel } from 'foldkit'
import type { Language } from '../../Language.ts'
import { styled } from '../../Styled.ts'
import { say, shortId } from '../../Text.ts'
import * as Ui from '../../Ui.ts'
import * as s from '../../Ui.styles.ts'
import * as rs from './Room.styles.ts'
import { Agents, Message, type Model, type OpenRoom, Send } from './Room.ts'

const roomLabel = (language: Language, room: RoomRef, me: Option.Option<AccountId>): string =>
  room.kind === 'engagement'
    ? say(language, 'room.engagement')
    : Option.contains(me, room.bidder)
      ? say(language, 'room.negotiation')
      : format(language, 'room.withBidder', { bidder: shortId(room.bidder) })

const authorOf = (language: Language, message: RoomMessage, me: Option.Option<AccountId>): string => {
  const person = Option.contains(me, message.author)
    ? say(language, 'room.you')
    : format(language, 'common.account', { id: shortId(message.author) })
  return Option.match(Option.fromNullishOr(message.agent), {
    onNone: () => person,
    onSome: (agent) => format(language, 'room.viaAgent', { person, agent: shortId(agent) }),
  })
}

const messageView = (
  h: Html.HtmlBuilder<Message>,
  language: Language,
  message: RoomMessage,
  me: Option.Option<AccountId>,
) =>
  h.keyed('li')(
    String(message.seq),
    [h.DataAttribute('mine', String(Option.contains(me, message.author))), ...styled(h, rs.message())],
    [h.p(styled(h, rs.author()), [authorOf(language, message, me)]), h.p(styled(h, rs.text()), [message.text])],
  )

const roomTabs = (
  h: Html.HtmlBuilder<Message>,
  language: Language,
  rooms: ReadonlyArray<RoomRef>,
  open: OpenRoom,
  me: Option.Option<AccountId>,
) =>
  rooms.length < 2
    ? h.empty
    : h.div(
        [h.Role('group'), h.AriaLabel(say(language, 'room.choose')), ...styled(h, rs.tabs())],
        rooms.map((room) =>
          h.keyed('button')(
            room.id,
            [
              h.Type('button'),
              h.AriaPressed(String(room.id === open.room)),
              h.OnClick(Message.SelectedRoom({ room: room.id })),
              ...styled(h, rs.tab()),
            ],
            [roomLabel(language, room, me)],
          ),
        ),
      )

const agentControls = (h: Html.HtmlBuilder<Message>, language: Language, open: OpenRoom) =>
  h.div(styled(h, s.section()), [
    h.div(styled(h, s.actions()), [
      Ui.button(h, {
        label: say(language, 'room.pause'),
        onClick: Message.ClickedPauseAgents(),
        busy: Agents.guards.Pausing(open.agents),
      }),
      Ui.button(h, {
        label: say(language, 'room.resume'),
        onClick: Message.ClickedResumeAgents(),
        busy: Agents.guards.Resuming(open.agents),
      }),
    ]),
    Agents.match(open.agents, {
      Unknown: () => h.p(styled(h, s.hint()), [say(language, 'room.agentsHint')]),
      Pausing: () => h.empty,
      Resuming: () => h.empty,
      Paused: () => Ui.notice(h, 'neutral', [h.p([], [say(language, 'room.paused')])]),
      Resumed: () => Ui.notice(h, 'neutral', [h.p([], [say(language, 'room.resumed')])]),
      Failed: ({ problem }) => Ui.problemNotice(h, language, problem),
    }),
  ])

const composer = (h: Html.HtmlBuilder<Message>, language: Language, open: OpenRoom) =>
  h.form(
    [h.OnSubmit(Message.SubmittedMessage()), ...styled(h, s.form())],
    [
      Ui.textArea(h, {
        id: 'room-message',
        label: say(language, 'room.message'),
        value: open.draft,
        onInput: (value) => Message.UpdatedDraft({ value }),
      }),
      Send.guards.Failed(open.send) ? Ui.problemNotice(h, language, open.send.problem) : h.empty,
      h.div(styled(h, s.actions()), [
        Ui.submit(h, {
          label: say(language, 'room.send'),
          busy: Send.guards.Sending(open.send) || Send.guards.Keyed(open.send),
        }),
      ]),
    ],
  )

const openRoomView = (
  h: Html.HtmlBuilder<Message>,
  model: Model,
  rooms: ReadonlyArray<RoomRef>,
  open: OpenRoom,
  me: Option.Option<AccountId>,
) =>
  h.div(styled(h, s.section()), [
    roomTabs(h, model.language, rooms, open, me),
    Array.match(open.messages, {
      onEmpty: () =>
        open.reading
          ? Ui.waiting(h, say(model.language, 'room.loading'))
          : h.p(styled(h, s.meta()), [say(model.language, 'room.empty')]),
      onNonEmpty: (messages) =>
        h.ol(
          [h.AriaLabel(say(model.language, 'room.messages')), h.AriaLive('polite'), ...styled(h, rs.messages())],
          messages.map((message) => messageView(h, model.language, message, me)),
        ),
    }),
    Option.match(open.maybeReadProblem, {
      onNone: () => h.empty,
      onSome: (problem) => Ui.problemNotice(h, model.language, problem),
    }),
    composer(h, model.language, open),
    agentControls(h, model.language, open),
  ])

/** The rooms, for a member of the job; nothing for anyone else. */
export const view = Submodel.defineView<Model, Message, { readonly me: Option.Option<AccountId> }>((model, { me }, h) =>
  AsyncData.matchData(model.rooms, {
    onEmpty: () => h.empty,
    onFailure: () => h.empty,
    onData: (rooms) =>
      Option.match(model.maybeOpen, {
        onNone: () => h.empty,
        onSome: (open) =>
          h.section(
            [h.AriaLabelledBy('job-room'), ...styled(h, s.panel())],
            [h.h2([h.Id('job-room')], [say(model.language, 'room.title')]), openRoomView(h, model, rooms, open, me)],
          ),
      }),
  }),
)
