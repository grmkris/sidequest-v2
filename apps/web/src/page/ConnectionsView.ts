import { format } from '@sidequest/i18n'
import type { Connection } from '@sidequest/protocol'
import { Array, Option } from 'effect'
import { AsyncData, type Html, Submodel } from 'foldkit'
import { signedInOnly } from '../Gate.ts'
import type { Language } from '../Language.ts'
import { AppRoute } from '../route.ts'
import type { Session } from '../Session.ts'
import { styled } from '../Styled.ts'
import { formatInstant, say, shortId } from '../Text.ts'
import * as Ui from '../Ui.ts'
import * as s from '../Ui.styles.ts'
import { Message, type Model } from './Connections.ts'

const connectionRow = (h: Html.HtmlBuilder<Message>, model: Model, connection: Connection, timeZone: string) => {
  const { client, redirect } = connection
  const language: Language = model.language
  return h.keyed('li')(connection.id, styled(h, s.row()), [
    h.h2(styled(h, s.rowTitle()), [client.name ?? say(language, 'connect.unnamed')]),
    h.p(styled(h, s.meta()), [
      client.publisher === null
        ? say(language, 'connect.unverified')
        : format(language, 'connect.publishedBy', { publisher: client.publisher }),
    ]),
    Ui.facts(h, [
      Ui.fact(h, say(language, 'connect.sendsTo'), Ui.dataText(h, redirect.host)),
      Ui.fact(h, say(language, 'connections.agent'), Ui.dataText(h, shortId(connection.agent))),
      Ui.fact(h, say(language, 'connections.since'), formatInstant(connection.connectedAt, language, timeZone)),
    ]),
    h.div(styled(h, s.actions()), [
      Ui.button(h, {
        label: say(language, 'connections.revoke'),
        onClick: Message.ClickedRevoke({ connection: connection.id }),
        kind: 'destructive',
        busy: Option.contains(model.maybeRevoking, connection.id),
      }),
    ]),
  ])
}

const connectionsView = (h: Html.HtmlBuilder<Message>, model: Model, timeZone: string) =>
  h.div(styled(h, s.page()), [
    Ui.maybeProblem(h, model.language, model.maybeProblem),
    AsyncData.matchData(model.connections, {
      onEmpty: () => Ui.waiting(h, say(model.language, 'connections.loading')),
      onFailure: (problem) => Ui.problemNotice(h, model.language, problem),
      onData: (connections) =>
        Array.match(connections, {
          onEmpty: () => h.p(styled(h, s.meta()), [say(model.language, 'connections.empty')]),
          onNonEmpty: (items) =>
            h.ul(
              [h.AriaLabel(say(model.language, 'connections.title')), ...styled(h, s.rows())],
              items.map((connection) => connectionRow(h, model, connection, timeZone)),
            ),
        }),
    }),
  ])

/** The apps the person connected over OAuth, each with where its access goes and a way to revoke it. */
export const view = Submodel.defineView<Model, Message, { readonly session: Session; readonly timeZone: string }>(
  (model, { session, timeZone }, h) =>
    h.div(styled(h, s.page()), [
      Ui.pageHead(h, say(model.language, 'connections.title'), [say(model.language, 'connections.lede')]),
      signedInOnly(h, { language: model.language, session, route: AppRoute.Connections() }, () =>
        connectionsView(h, model, timeZone),
      ),
    ]),
)
