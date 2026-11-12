import { Schema } from 'effect'
import { Html, Runtime, type Update } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { format } from '@sidequest/i18n'
import { styled } from './Styled.ts'
import * as styles from './App.styles.ts'

export const Flags = Schema.Struct({ locale: Schema.Literals(['en', 'sl']), release: Schema.String })
export type Flags = typeof Flags.Type
export const Model = Schema.Struct({ locale: Flags.fields.locale, release: Schema.String })
export type Model = typeof Model.Type
export const Message = defineMessageUnion({})
export type Message = typeof Message.Type

export const init: Runtime.ApplicationInit<Model, Message, Flags> = (flags) => ({
  model: { locale: flags.locale, release: flags.release },
})

export const update = (model: Model): Update.Return<Model, Message> => ({ model })

export const view = (model: Model, h: Html.HtmlBuilder<Message>): Html.Document => ({
  title: format(model.locale, 'foundation.title', {}),
  body: h.main(styled(h, styles.shell()), [
    h.section(styled(h, styles.card()), [
      h.h1([], [format(model.locale, 'foundation.title', {})]),
      h.p([], [format(model.locale, 'foundation.body', {})]),
      h.small([], [format(model.locale, 'foundation.release', { release: model.release })]),
    ]),
  ]),
})
