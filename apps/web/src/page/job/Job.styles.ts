import { style } from '../../zyzz.config.ts'

export const main = style({ display: 'grid', gap: '28px', minInlineSize: '0', maxInlineSize: '50rem' })
export const description = style({ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' })
export const amount = style({ fontSize: 'subheading', fontWeight: 700, fontVariantNumeric: 'tabular-nums' })
export const deliverables = style({ display: 'grid', gap: '2px', paddingInlineStart: '18px' })
export const versionTitle = style({ margin: '0', fontSize: 'subheading', fontWeight: 650 })
/** A proposal's labels and an accept's, in a row that wraps. */
export const labels = style({ listStyle: 'none', display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' })

/** The confirming slip: the one place the seal colour appears, with a thick seal edge on the start side. */
export const slip = style({
  display: 'grid',
  gap: '16px',
  padding: 'clamp(16px, 4vw, 24px)',
  borderRadius: 'panel',
  borderInlineStartWidth: '6px',
  borderInlineStartStyle: 'solid',
  borderInlineStartColor: 'seal',
  backgroundColor: 'sealWash',
  '& > h3': { color: 'seal' },
})
/** The slip's amount, large and in tabular figures. */
export const slipAmount = style({
  fontSize: 'figure',
  fontWeight: 700,
  lineHeight: 1,
  letterSpacing: '-0.02em',
  fontVariantNumeric: 'tabular-nums',
  overflowWrap: 'anywhere',
})
/** What the slip binds, listed plainly beneath the amount. */
export const slipTerms = style({ display: 'grid', gap: '10px', paddingInlineStart: '20px' })
