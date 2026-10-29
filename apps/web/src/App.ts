import { Schema } from 'effect'
import { Html, Runtime, type Update } from 'foldkit'
import { Button } from '@foldkit/ui'
import { defineMessageUnion } from 'foldkit/message'
import { modifyFields } from 'foldkit/struct'
import { format } from '@sidequest/i18n'
import { styled } from './Styled.ts'
import * as styles from './App.styles.ts'

export const Flags = Schema.Struct({ locale: Schema.Literals(['en', 'sl']), release: Schema.String })
export type Flags = typeof Flags.Type
export const Model = Schema.Struct({ count: Schema.Number, locale: Flags.fields.locale, release: Schema.String })
export type Model = typeof Model.Type
export const Message = defineMessageUnion({ ClickedIncrement: {}, ClickedReset: {} })
export type Message = typeof Message.Type

export const init: Runtime.ApplicationInit<Model, Message, Flags> = (flags) => ({
  model: { count: 0, locale: flags.locale, release: flags.release },
})

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    ClickedIncrement: () => ({ model: modifyFields(model, { count: (count) => count + 1 }) }),
    ClickedReset: () => ({ model: modifyFields(model, { count: () => 0 }) }),
  })

export const view = (model: Model, h: Html.HtmlBuilder<Message>): Html.Document => ({
  title: format(model.locale, 'foundation.title', {}),
  body: h.main(styled(h, styles.shell()), [
    h.section(styled(h, styles.card()), [
      h.p([h.Class('eyebrow')], ['SIDEQUEST V2']),
      h.h1([], [format(model.locale, 'foundation.title', {})]),
      h.p([], [format(model.locale, 'foundation.body', {})]),
      h.p([], [format(model.locale, 'foundation.count', { count: model.count })]),
      h.div(styled(h, styles.actions()), [
        Button.view(
          {
            onClick: Message.ClickedIncrement(),
            toView: ({ button }) => h.button([...button, ...styled(h, styles.button())], ['+']),
          },
          h,
        ),
        Button.view(
          {
            onClick: Message.ClickedReset(),
            toView: ({ button }) => h.button([...button, ...styled(h, styles.secondary())], ['Reset']),
          },
          h,
        ),
      ]),
      h.small([], [`release ${model.release}`]),
    ]),
  ]),
})
