import { Array, Option } from 'effect'
import type { Html } from 'foldkit'
import { cx } from 'zyzz'
import type { Language } from './Language.ts'
import { type Problem, problemText } from './Problem.ts'
import { styled } from './Styled.ts'
import * as s from './Ui.styles.ts'

// View helpers every page shares: fields with their labels and errors, actions, notices. Each takes the caller's `h`.

type Builder<Message> = Html.HtmlBuilder<Message>
type Attribute<Message> = Html.TextareaAttribute<Message>

export type FieldConfig<Message> = {
  readonly id: string
  readonly label: string
  readonly value: string
  readonly onInput: (value: string) => Message
  readonly error?: Option.Option<string>
  readonly hint?: string
  readonly type?: string
  readonly inputMode?: string
  readonly autocomplete?: string
  readonly required?: boolean
}

const describedBy = <Message>(h: Builder<Message>, config: FieldConfig<Message>): ReadonlyArray<Attribute<Message>> => {
  const ids = [
    ...(config.hint === undefined ? [] : [`${config.id}-hint`]),
    ...(Option.isSome(config.error ?? Option.none()) ? [`${config.id}-error`] : []),
  ]
  return Array.isReadonlyArrayNonEmpty(ids) ? [h.AriaDescribedBy(ids.join(' '))] : []
}

const fieldFrame = <Message>(h: Builder<Message>, config: FieldConfig<Message>, control: Html.Html): Html.Html =>
  h.div(styled(h, s.field()), [
    h.label([h.For(config.id), ...styled(h, s.label())], [config.label]),
    config.hint === undefined ? h.empty : h.p([h.Id(`${config.id}-hint`), ...styled(h, s.hint())], [config.hint]),
    control,
    Option.match(config.error ?? Option.none(), {
      onNone: () => h.empty,
      onSome: (error) => h.p([h.Id(`${config.id}-error`), ...styled(h, s.fieldError())], [error]),
    }),
  ])

const controlAttributes = <Message>(
  h: Builder<Message>,
  config: FieldConfig<Message>,
): ReadonlyArray<Attribute<Message>> => [
  h.Id(config.id),
  h.Name(config.id),
  h.Value(config.value),
  h.OnInput(config.onInput),
  h.AriaInvalid(Option.isSome(config.error ?? Option.none())),
  h.Required(config.required ?? false),
  ...describedBy(h, config),
]

/** A one-line field with its label, an optional hint and its error. */
export const textField = <Message>(h: Builder<Message>, config: FieldConfig<Message>): Html.Html =>
  fieldFrame(
    h,
    config,
    h.input([
      ...controlAttributes(h, config),
      h.Type(config.type ?? 'text'),
      ...(config.inputMode === undefined ? [] : [h.InputMode(config.inputMode)]),
      h.Autocomplete(config.autocomplete ?? 'off'),
      ...styled(h, s.input()),
    ]),
  )

/** A field for a few lines. */
export const textArea = <Message>(h: Builder<Message>, config: FieldConfig<Message>): Html.Html =>
  fieldFrame(
    h,
    config,
    h.textarea([...controlAttributes(h, config), h.Rows(4), ...styled(h, cx(s.input(), s.textArea()))]),
  )

export type ActionKind = 'primary' | 'secondary' | 'destructive' | 'seal'

const kindStyles = {
  primary: () => cx(s.pressable(), s.primary()),
  secondary: () => cx(s.pressable(), s.secondary()),
  destructive: () => cx(s.pressable(), s.secondary(), s.destructive()),
  seal: () => cx(s.pressable(), s.primary(), s.seal()),
}

const kindStyle = (kind: ActionKind) => kindStyles[kind]()

/** A button that sends `message` when pressed. While `busy`, it is disabled and says so. */
export const button = <Message>(
  h: Builder<Message>,
  config: {
    readonly label: string
    readonly onClick: Message
    readonly kind?: ActionKind
    readonly busy?: boolean
    readonly disabled?: boolean
  },
): Html.Html =>
  h.button(
    [
      h.Type('button'),
      h.OnClick(config.onClick),
      h.Disabled(config.busy === true || config.disabled === true),
      h.AriaBusy(config.busy === true),
      ...styled(h, kindStyle(config.kind ?? 'secondary')),
    ],
    [config.label],
  )

/** The submit button of a form. */
export const submit = <Message>(
  h: Builder<Message>,
  config: { readonly label: string; readonly busy: boolean; readonly kind?: ActionKind },
): Html.Html =>
  h.button(
    [
      h.Type('submit'),
      h.Disabled(config.busy),
      h.AriaBusy(config.busy),
      ...styled(h, kindStyle(config.kind ?? 'primary')),
    ],
    [config.label],
  )

/** A link styled as an action. */
export const actionLink = <Message>(
  h: Builder<Message>,
  config: { readonly label: string; readonly href: string; readonly kind?: ActionKind },
): Html.Html => h.a([h.Href(config.href), ...styled(h, kindStyle(config.kind ?? 'primary'))], [config.label])

/** A button that reads as a link. */
export const linkButton = <Message>(h: Builder<Message>, label: string, onClick: Message): Html.Html =>
  h.button([h.Type('button'), h.OnClick(onClick), ...styled(h, s.linkButton())], [label])

export type Tone = 'neutral' | 'danger' | 'done'

/** A notice: `alert` for a problem, which a screen reader announces at once; `status` for anything else. */
export const notice = <Message>(
  h: Builder<Message>,
  tone: Tone,
  children: ReadonlyArray<Html.Html | string>,
): Html.Html =>
  h.div(
    [h.Role(tone === 'danger' ? 'alert' : 'status'), h.DataAttribute('tone', tone), ...styled(h, s.notice())],
    children,
  )

/** What went wrong, in one sentence. */
export const problemNotice = <Message>(h: Builder<Message>, language: Language, problem: Problem): Html.Html =>
  notice(h, 'danger', [h.p([], [problemText(language, problem)])])

/** A problem when there is one. */
export const maybeProblem = <Message>(
  h: Builder<Message>,
  language: Language,
  maybe: Option.Option<Problem>,
): Html.Html => Option.match(maybe, { onNone: () => h.empty, onSome: (problem) => problemNotice(h, language, problem) })

/** A line that waits for data. */
export const waiting = <Message>(h: Builder<Message>, text: string): Html.Html =>
  h.p([h.Role('status'), ...styled(h, s.waiting())], [text])

/** A page's title and lede. The title is the page's one `h1`, which takes focus after a route change. */
export const pageHead = <Message>(
  h: Builder<Message>,
  title: string,
  lede: ReadonlyArray<Html.Html | string> = [],
): Html.Html =>
  h.header(styled(h, s.pageHead()), [
    h.h1([], [title]),
    ...(Array.isReadonlyArrayNonEmpty(lede) ? [h.p(styled(h, s.lede()), lede)] : []),
  ])

/** A pair in a list of facts. */
export const fact = <Message>(
  h: Builder<Message>,
  name: string,
  value: Html.Html | string,
): ReadonlyArray<Html.Html> => [h.dt(styled(h, s.factName()), [name]), h.dd(styled(h, s.factValue()), [value])]

/** A list of facts. */
export const facts = <Message>(h: Builder<Message>, pairs: ReadonlyArray<ReadonlyArray<Html.Html>>): Html.Html =>
  h.dl(styled(h, s.facts()), pairs.flat())

/** A value people compare character by character, such as a hash. */
export const dataText = <Message>(h: Builder<Message>, value: string): Html.Html =>
  h.span([h.Title(value), ...styled(h, s.data())], [value])

/** A small status word. */
export const chip = <Message>(h: Builder<Message>, text: string, tone: Tone | 'seal' = 'neutral'): Html.Html =>
  h.span([h.DataAttribute('tone', tone), ...styled(h, s.chip())], [text])

/** A choice among a few fixed options. */
export const selectField = <Message>(
  h: Builder<Message>,
  config: {
    readonly id: string
    readonly label: string
    readonly value: string
    readonly options: ReadonlyArray<{ readonly value: string; readonly label: string }>
    readonly onChange: (value: string) => Message
    readonly hint?: string
  },
): Html.Html =>
  h.div(styled(h, s.field()), [
    h.label([h.For(config.id), ...styled(h, s.label())], [config.label]),
    config.hint === undefined ? h.empty : h.p([h.Id(`${config.id}-hint`), ...styled(h, s.hint())], [config.hint]),
    h.select(
      [
        h.Id(config.id),
        h.Name(config.id),
        h.Value(config.value),
        h.OnChange(config.onChange),
        ...(config.hint === undefined ? [] : [h.AriaDescribedBy(`${config.id}-hint`)]),
        ...styled(h, s.input()),
      ],
      config.options.map((option) =>
        h.keyed('option')(
          option.value,
          [h.Value(option.value), h.Selected(option.value === config.value)],
          [option.label],
        ),
      ),
    ),
  ])
