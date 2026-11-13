import { style } from '../../../zyzz.config.ts'

/** The transcript: one message under another, oldest first. */
export const transcript = style({ listStyle: 'none', display: 'grid', gap: '10px', minInlineSize: '0' })

/** One message: who and when above, the text as written below. */
export const line = style({
  display: 'grid',
  gap: '4px',
  padding: '10px 12px',
  borderRadius: 'panel',
  borderWidth: '1px',
  borderStyle: 'solid',
  borderColor: 'hairline',
  minInlineSize: '0',
})

/** A message the person wrote, set off at the start edge. */
export const mine = style({ borderInlineStartWidth: '4px', borderInlineStartColor: 'ink2' })

/** A message's text: plain, its line breaks kept, long words broken. */
export const text = style({ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' })

/** The person's rooms with each bidder, as a row of choices. */
export const roomChoices = style({ display: 'flex', flexWrap: 'wrap', gap: '8px' })

/** A disclosure bundle, shown for copying. */
export const bundle = style({
  fontFamily: 'data',
  fontSize: 'small',
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
  maxBlockSize: '16rem',
  overflow: 'auto',
})
