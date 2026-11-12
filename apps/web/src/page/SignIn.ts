import { format } from '@sidequest/i18n'
import { SessionView, SignInChallenge, WalletAddress, WalletSignature } from '@sidequest/protocol'
import { Effect, Option, Schema } from 'effect'
import { Command, type Html, Submodel, type Update } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'
import { SidequestClient } from '../Api.ts'
import { arcChainId } from '../Chain.ts'
import type { Language } from '../Language.ts'
import { failedWith, Problem } from '../Problem.ts'
import { safeReturn } from '../route.ts'
import { addressOf, Session } from '../Session.ts'
import { styled } from '../Styled.ts'
import { say } from '../Text.ts'
import * as Ui from '../Ui.ts'
import * as s from '../Ui.styles.ts'
import { Connection, Wallet } from '../Wallet.ts'
import * as ss from './SignIn.styles.ts'

// Signing in with the browser's wallet: connect it, make sure it is on Arc testnet, ask the server for a SIWE message,
// sign it with `personal_sign`, and send the signature back. The server sets the session cookie.

// MODEL

const Step = defineTaggedUnion({
  Disconnected: {},
  Connecting: {},
  WrongNetwork: { connection: Connection },
  Switching: { connection: Connection },
  Connected: { connection: Connection },
  RequestingChallenge: { connection: Connection },
  Signing: { connection: Connection },
  Verifying: { connection: Connection },
})
type Step = typeof Step.Type

export const Model = Schema.Struct({
  step: Step,
  next: Schema.Option(Schema.String),
  maybeProblem: Schema.Option(Problem),
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  ClickedConnect: {},
  SucceededConnectWallet: { connection: Connection },
  FailedConnectWallet: { problem: Problem },
  ClickedSwitchNetwork: {},
  SucceededSwitchNetwork: {},
  FailedSwitchNetwork: { problem: Problem },
  ClickedSignIn: {},
  SucceededRequestChallenge: { challenge: SignInChallenge },
  FailedRequestChallenge: { problem: Problem },
  SucceededSignChallenge: { message: Schema.String, signature: WalletSignature },
  FailedSignChallenge: { problem: Problem },
  SucceededVerifySignature: { session: SessionView },
  FailedVerifySignature: { problem: Problem },
  ClickedSignOut: {},
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({
  SignedIn: { session: SessionView, next: Schema.String },
  RequestedSignOut: {},
})
export type OutMessage = typeof OutMessage.Type

// COMMAND

export const ConnectWallet = Command.define('ConnectWallet', {
  messages: [Message.SucceededConnectWallet, Message.FailedConnectWallet],
  execute: Effect.gen(function* () {
    const connection = yield* (yield* Wallet).connect
    return Message.SucceededConnectWallet({ connection })
  }).pipe(Effect.catch(failedWith(Message.FailedConnectWallet))),
})

export const SwitchNetwork = Command.define('SwitchNetwork', {
  messages: [Message.SucceededSwitchNetwork, Message.FailedSwitchNetwork],
  execute: Effect.gen(function* () {
    yield* (yield* Wallet).switchToArc
    return Message.SucceededSwitchNetwork()
  }).pipe(Effect.catch(failedWith(Message.FailedSwitchNetwork))),
})

export const RequestChallenge = Command.define('RequestChallenge', {
  args: { address: WalletAddress },
  messages: [Message.SucceededRequestChallenge, Message.FailedRequestChallenge],
  execute: ({ address }) =>
    Effect.gen(function* () {
      const api = yield* (yield* SidequestClient).api
      const challenge = yield* api.session.challenge({ payload: { address } })
      return Message.SucceededRequestChallenge({ challenge })
    }).pipe(Effect.catch(failedWith(Message.FailedRequestChallenge))),
})

export const SignChallenge = Command.define('SignChallenge', {
  args: { address: WalletAddress, message: Schema.String },
  messages: [Message.SucceededSignChallenge, Message.FailedSignChallenge],
  execute: ({ address, message }) =>
    Effect.gen(function* () {
      const signature = yield* (yield* Wallet).signMessage(address, message)
      return Message.SucceededSignChallenge({ message, signature })
    }).pipe(Effect.catch(failedWith(Message.FailedSignChallenge))),
})

export const VerifySignature = Command.define('VerifySignature', {
  args: { message: Schema.String, signature: WalletSignature },
  messages: [Message.SucceededVerifySignature, Message.FailedVerifySignature],
  execute: ({ message, signature }) =>
    Effect.gen(function* () {
      const api = yield* (yield* SidequestClient).api
      const session = yield* api.session.verify({ payload: { message, signature } })
      return Message.SucceededVerifySignature({ session })
    }).pipe(Effect.catch(failedWith(Message.FailedVerifySignature))),
})

// INIT

export const init = (next: Option.Option<string>): Model => ({
  step: Step.Disconnected(),
  next,
  maybeProblem: Option.none(),
})

// UPDATE

type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, OutMessage, SidequestClient | Wallet>

const connectionOf = (step: Step): Option.Option<Connection> =>
  Step.match(step, {
    Disconnected: () => Option.none(),
    Connecting: () => Option.none(),
    WrongNetwork: ({ connection }) => Option.some(connection),
    Switching: ({ connection }) => Option.some(connection),
    Connected: ({ connection }) => Option.some(connection),
    RequestingChallenge: ({ connection }) => Option.some(connection),
    Signing: ({ connection }) => Option.some(connection),
    Verifying: ({ connection }) => Option.some(connection),
  })

const withStep = (model: Model, step: Step): Model =>
  modifyFields(model, { step: () => step, maybeProblem: () => Option.none() })

/** A failure: the problem shows, and the person is back where they can try again. */
const failed = (model: Model, problem: Problem): UpdateReturn => ({
  model: modifyFields(model, {
    step: () =>
      Option.match(connectionOf(model.step), {
        onNone: () => Step.Disconnected(),
        onSome: (connection) =>
          connection.chainId === arcChainId ? Step.Connected({ connection }) : Step.WrongNetwork({ connection }),
      }),
    maybeProblem: () => Option.some(problem),
  }),
})

/** Whichever step the person is on, the wallet it connected. */
const withConnection = (model: Model, next: (connection: Connection) => UpdateReturn): UpdateReturn =>
  Option.match(connectionOf(model.step), { onNone: () => ({ model }), onSome: next })

export const update = (model: Model, message: Message): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    ClickedConnect: () => ({ model: withStep(model, Step.Connecting()), commands: [ConnectWallet()] }),
    SucceededConnectWallet: ({ connection }) => ({
      model: withStep(
        model,
        connection.chainId === arcChainId ? Step.Connected({ connection }) : Step.WrongNetwork({ connection }),
      ),
    }),
    FailedConnectWallet: ({ problem }) => failed(model, problem),
    ClickedSwitchNetwork: () =>
      withConnection(model, (connection) => ({
        model: withStep(model, Step.Switching({ connection })),
        commands: [SwitchNetwork()],
      })),
    SucceededSwitchNetwork: () =>
      withConnection(model, (connection) => ({
        model: withStep(model, Step.Connected({ connection: { address: connection.address, chainId: arcChainId } })),
      })),
    FailedSwitchNetwork: ({ problem }) => failed(model, problem),
    ClickedSignIn: () =>
      withConnection(model, (connection) => ({
        model: withStep(model, Step.RequestingChallenge({ connection })),
        commands: [RequestChallenge({ address: connection.address })],
      })),
    SucceededRequestChallenge: ({ challenge }) =>
      withConnection(model, (connection) => ({
        model: withStep(model, Step.Signing({ connection })),
        commands: [SignChallenge({ address: connection.address, message: challenge.message })],
      })),
    FailedRequestChallenge: ({ problem }) => failed(model, problem),
    SucceededSignChallenge: ({ message: signed, signature }) =>
      withConnection(model, (connection) => ({
        model: withStep(model, Step.Verifying({ connection })),
        commands: [VerifySignature({ message: signed, signature })],
      })),
    FailedSignChallenge: ({ problem }) => failed(model, problem),
    SucceededVerifySignature: ({ session }) => ({
      model: init(model.next),
      outMessage: OutMessage.SignedIn({ session, next: safeReturn(model.next) }),
    }),
    FailedVerifySignature: ({ problem }) => failed(model, problem),
    ClickedSignOut: () => ({ model, outMessage: OutMessage.RequestedSignOut() }),
  })

// VIEW

type ViewInputs = { readonly language: Language; readonly session: Session }

const busy = (h: Html.HtmlBuilder<Message>, label: string) =>
  Ui.button(h, { label, onClick: Message.ClickedSignIn(), kind: 'primary', busy: true })

const walletFacts = (h: Html.HtmlBuilder<Message>, language: Language, connection: Connection) =>
  Ui.facts(h, [
    Ui.fact(h, say(language, 'signIn.wallet'), Ui.dataText(h, connection.address)),
    Ui.fact(
      h,
      say(language, 'signIn.network'),
      connection.chainId === arcChainId
        ? say(language, 'signIn.arc')
        : format(language, 'signIn.otherChain', { chainId: connection.chainId }),
    ),
  ])

const stepView = (h: Html.HtmlBuilder<Message>, language: Language, step: Step): ReadonlyArray<Html.Html> =>
  Step.match(step, {
    Disconnected: () => [
      Ui.button(h, { label: say(language, 'signIn.connect'), onClick: Message.ClickedConnect(), kind: 'primary' }),
    ],
    Connecting: () => [busy(h, say(language, 'signIn.connecting'))],
    WrongNetwork: ({ connection }) => [
      walletFacts(h, language, connection),
      h.p([], [say(language, 'signIn.wrongNetwork')]),
      Ui.button(h, { label: say(language, 'signIn.switch'), onClick: Message.ClickedSwitchNetwork(), kind: 'primary' }),
    ],
    Switching: ({ connection }) => [walletFacts(h, language, connection), busy(h, say(language, 'signIn.switching'))],
    Connected: ({ connection }) => [
      walletFacts(h, language, connection),
      h.div(styled(h, s.actions()), [
        Ui.button(h, { label: say(language, 'signIn.signIn'), onClick: Message.ClickedSignIn(), kind: 'primary' }),
        Ui.button(h, { label: say(language, 'signIn.otherWallet'), onClick: Message.ClickedConnect() }),
      ]),
    ],
    RequestingChallenge: ({ connection }) => [
      walletFacts(h, language, connection),
      busy(h, say(language, 'signIn.preparing')),
    ],
    Signing: ({ connection }) => [walletFacts(h, language, connection), busy(h, say(language, 'signIn.signing'))],
    Verifying: ({ connection }) => [walletFacts(h, language, connection), busy(h, say(language, 'signIn.verifying'))],
  })

const signedInView = (h: Html.HtmlBuilder<Message>, language: Language, session: SessionView) =>
  h.section(styled(h, s.panel()), [
    h.p([], [say(language, 'signIn.already')]),
    Ui.facts(h, [Ui.fact(h, say(language, 'signIn.wallet'), Ui.dataText(h, addressOf(session)))]),
    h.div(styled(h, s.actions()), [
      Ui.button(h, { label: say(language, 'shell.signOut'), onClick: Message.ClickedSignOut() }),
    ]),
  ])

export const view = Submodel.defineView<Model, Message, ViewInputs>((model, { language, session }, h) =>
  h.div(styled(h, s.page()), [
    Ui.pageHead(h, say(language, 'signIn.title'), [say(language, 'signIn.lede')]),
    Session.guards.SignedIn(session)
      ? signedInView(h, language, session.session)
      : h.section(
          [h.AriaLabelledBy('sign-in-steps'), ...styled(h, s.panel())],
          [
            h.h2([h.Id('sign-in-steps'), ...styled(h, s.visuallyHidden())], [say(language, 'signIn.title')]),
            h.ol(styled(h, ss.steps()), [
              h.li(
                [h.DataAttribute('done', String(Option.isSome(connectionOf(model.step))))],
                [say(language, 'signIn.stepConnect')],
              ),
              h.li([], [say(language, 'signIn.stepSign')]),
            ]),
            ...stepView(h, language, model.step),
            Ui.maybeProblem(h, language, model.maybeProblem),
          ],
        ),
  ]),
)
