import { Array, Option } from 'effect'
import { type Html, Submodel } from 'foldkit'
import { textError } from '../Forms.ts'
import type { Language } from '../Language.ts'
import { refusalText } from '../Publishing.ts'
import { safeReturn } from '../route.ts'
import { styled } from '../Styled.ts'
import { type PlainKey, say } from '../Text.ts'
import * as Ui from '../Ui.ts'
import * as s from '../Ui.styles.ts'
import {
  Action,
  identityOf,
  type LinkedAccount,
  maximumName,
  Message,
  type Model,
  offersProfile,
  PersonRead,
  type PersonSummary,
  type Publication,
} from './Identity.ts'
import * as InboxRelays from './InboxRelays.ts'
import { setupProblemText, view as setupView } from './SignerSetupView.ts'

const publishedKeys: Readonly<Record<Publication, PlainKey>> = {
  profile: 'identity.published.profile',
  walletLink: 'identity.published.walletLink',
}

/** Where the person's last action stands. */
const actionNotice = (h: Html.HtmlBuilder<Message>, language: Language, action: Action): Html.Html =>
  Action.match(action, {
    Idle: () => h.empty,
    NameInvalid: () => h.empty,
    Publishing: () => Ui.waiting(h, say(language, 'identity.publishing')),
    ConnectingWallet: () => Ui.waiting(h, say(language, 'identity.connectingWallet')),
    SigningInWallet: () => Ui.waiting(h, say(language, 'identity.signingInWallet')),
    Published: ({ publication }) => Ui.notice(h, 'done', [h.p([], [say(language, publishedKeys[publication])])]),
    Refused: ({ refusal }) => Ui.notice(h, 'danger', [h.p([], [refusalText(language, refusal)])]),
    WalletDeclined: () => Ui.notice(h, 'danger', [h.p([], [say(language, 'identity.walletDeclined')])]),
    SignerFailed: ({ reason }) => Ui.notice(h, 'danger', [h.p([], [setupProblemText(language, reason)])]),
    Failed: ({ problem }) => Ui.problemNotice(h, language, problem),
  })

/** Why there is no name to publish here: the key has a profile, or its profile is the extension's own. */
const profileNote = (h: Html.HtmlBuilder<Message>, model: Model) => {
  const language = model.language
  if (PersonRead.guards.Read(model.person) && model.person.person.hasProfile) {
    return h.p(styled(h, s.meta()), [say(language, 'identity.profile.known')])
  }
  return Option.exists(identityOf(model), (identity) => identity.signerKind === 'nip07') &&
    (PersonRead.guards.Unknown(model.person) || PersonRead.guards.Read(model.person))
    ? h.p(styled(h, s.meta()), [say(language, 'identity.profile.fromExtension')])
    : h.empty
}

const profileSection = (h: Html.HtmlBuilder<Message>, model: Model) => {
  const language = model.language
  const publishing = Action.guards.Publishing(model.action) && model.action.publication === 'profile'
  return h.section(
    [h.AriaLabelledBy('identity-profile'), ...styled(h, s.panel())],
    [
      h.h2([h.Id('identity-profile')], [say(language, 'identity.profile.title')]),
      offersProfile(model) ? profileForm(h, model, publishing) : profileNote(h, model),
    ],
  )
}

const profileForm = (h: Html.HtmlBuilder<Message>, model: Model, publishing: boolean) => {
  const language = model.language
  return h.form(
    [h.OnSubmit(Message.SubmittedProfile()), h.Novalidate(true), ...styled(h, s.form())],
    [
      Ui.textField(h, {
        id: 'identity-name',
        label: say(language, 'identity.profile.name'),
        hint: say(language, 'identity.profile.nameHint'),
        value: model.name,
        onInput: (value) => Message.UpdatedName({ value }),
        autocomplete: 'nickname',
        required: true,
        error: Action.guards.NameInvalid(model.action) ? textError(model.name, maximumName, language) : Option.none(),
      }),
      h.div(styled(h, s.actions()), [
        Ui.submit(h, {
          label: say(language, publishing ? 'identity.publishing' : 'identity.profile.submit'),
          busy: publishing,
        }),
      ]),
    ],
  )
}

/** Back to the page that sent the person here, once they can act there. */
const continueLink = (h: Html.HtmlBuilder<Message>, model: Model) =>
  Option.match(model.maybeNext, {
    onNone: () => h.empty,
    onSome: (next) =>
      Ui.notice(h, 'done', [
        h.p([], [say(model.language, 'identity.ready')]),
        h.div(styled(h, s.actions()), [
          Ui.actionLink(h, { label: say(model.language, 'identity.continue'), href: safeReturn(Option.some(next)) }),
        ]),
      ]),
  })

const walletSection = (h: Html.HtmlBuilder<Message>, model: Model) => {
  const language = model.language
  const linking =
    Action.guards.ConnectingWallet(model.action) ||
    Action.guards.SigningInWallet(model.action) ||
    (Action.guards.Publishing(model.action) && model.action.publication === 'walletLink')
  return h.section(
    [h.AriaLabelledBy('identity-wallet'), ...styled(h, s.panel())],
    [
      h.h2([h.Id('identity-wallet')], [say(language, 'identity.wallet.title')]),
      h.p([], [say(language, 'identity.wallet.lede')]),
      h.div(styled(h, s.actions()), [
        Ui.button(h, {
          label: say(language, 'identity.wallet.link'),
          onClick: Message.ClickedLinkWallet(),
          kind: 'primary',
          busy: linking,
        }),
      ]),
    ],
  )
}

const walletRow = (h: Html.HtmlBuilder<Message>, language: Language, wallet: LinkedAccount) =>
  h.keyed('li')(wallet.account, styled(h, s.row()), [
    Ui.dataText(h, wallet.account),
    wallet.verification === 'verified'
      ? Ui.chip(h, say(language, 'identity.person.verified'), 'done')
      : Ui.chip(h, say(language, 'identity.person.unverified')),
  ])

const personFacts = (h: Html.HtmlBuilder<Message>, language: Language, person: PersonSummary) =>
  h.div(styled(h, s.section()), [
    Ui.facts(h, [
      Ui.fact(
        h,
        say(language, 'identity.person.name'),
        Option.getOrElse(person.maybeName, () => say(language, 'identity.person.noName')),
      ),
    ]),
    Array.match(person.wallets, {
      onEmpty: () => h.p(styled(h, s.meta()), [say(language, 'identity.person.noWallets')]),
      onNonEmpty: (wallets) =>
        h.ul(
          [h.AriaLabel(say(language, 'identity.person.wallets')), ...styled(h, s.rows())],
          wallets.map((wallet) => walletRow(h, language, wallet)),
        ),
    }),
  ])

const personSection = (h: Html.HtmlBuilder<Message>, model: Model) => {
  const language = model.language
  return h.section(
    [h.AriaLabelledBy('identity-person'), ...styled(h, s.panel())],
    [
      h.h2([h.Id('identity-person')], [say(language, 'identity.person.title')]),
      PersonRead.match(model.person, {
        Unread: () => h.empty,
        Reading: () => Ui.waiting(h, say(language, 'identity.person.reading')),
        Unknown: () => h.p(styled(h, s.meta()), [say(language, 'identity.person.unknown')]),
        Read: ({ person }) => personFacts(h, language, person),
        Failed: ({ problem }) => Ui.problemNotice(h, language, problem),
      }),
    ],
  )
}

/** Where the key receives private messages: what the index knows, or the stage's defaults to publish. */
const inboxSection = (h: Html.HtmlBuilder<Message>, model: Model) =>
  Option.match(identityOf(model), {
    onNone: () => h.empty,
    onSome: ({ pubkey }) =>
      h.submodel({
        slotId: 'inbox-relays',
        model: model.inbox,
        view: InboxRelays.view,
        viewInputs: {
          pubkey,
          maybeKnown: PersonRead.match(model.person, {
            Unread: () => Option.none(),
            Reading: () => Option.none(),
            Failed: () => Option.none(),
            Unknown: () => Option.some([]),
            Read: ({ person }) => Option.some(person.inboxRelays),
          }),
        },
        toParentMessage: (message) => Message.GotInboxRelaysMessage({ message }),
      }),
  })

/** The person's signer, then, once it is ready, their profile, their wallet's link and what the index knows. */
export const view = Submodel.defineView<Model, Message>((model, h) =>
  h.div(styled(h, s.page()), [
    Ui.pageHead(h, say(model.language, 'identity.title'), [say(model.language, 'identity.lede')]),
    h.submodel({
      slotId: 'signer-setup',
      model: model.setup,
      view: setupView,
      toParentMessage: (message) => Message.GotSetupMessage({ message }),
    }),
    ...Option.match(identityOf(model), {
      onNone: () => [],
      onSome: () => [
        continueLink(h, model),
        actionNotice(h, model.language, model.action),
        profileSection(h, model),
        walletSection(h, model),
        inboxSection(h, model),
        personSection(h, model),
      ],
    }),
  ]),
)
