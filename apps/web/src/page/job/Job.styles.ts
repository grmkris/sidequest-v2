import { style } from '../../zyzz.config.ts'

/** The job beside its conversation on a wide screen, when there is one; one column, conversation last, on a phone. */
export const layout = style({
  display: 'grid',
  gap: '32px',
  alignItems: 'start',
  '@media (min-width: 1040px)': {
    '&:has(> :nth-child(2):not(:empty))': { gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 24rem)' },
  },
})
export const main = style({ display: 'grid', gap: '28px', minInlineSize: '0', maxInlineSize: '50rem' })
export const aside = style({
  display: 'grid',
  gap: '24px',
  minInlineSize: '0',
  ':empty': { display: 'none' },
  '@media (min-width: 1040px)': { position: 'sticky', insetBlockStart: '24px' },
})
export const description = style({ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' })
export const amount = style({ fontSize: 'subheading', fontWeight: 700, fontVariantNumeric: 'tabular-nums' })
export const deliverables = style({ display: 'grid', gap: '2px', paddingInlineStart: '18px' })
export const versionTitle = style({ margin: '0', fontSize: 'subheading', fontWeight: 650 })
export const earlier = style({
  display: 'grid',
  gap: '12px',
  borderBlockStartWidth: '1px',
  borderBlockStartStyle: 'solid',
  borderBlockStartColor: 'hairline',
  paddingBlockStart: '12px',
  '& > summary': { cursor: 'pointer', fontWeight: 600, minBlockSize: '44px', display: 'flex', alignItems: 'center' },
})
export const version = style({ display: 'grid', gap: '10px', paddingBlock: '8px' })

/** The signing slip: the one place the seal colour appears. A thick seal edge on the start side, the amount large and
 * in tabular figures, and the consequences listed plainly beneath. */
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
export const slipAmount = style({
  fontSize: 'figure',
  fontWeight: 700,
  lineHeight: 1,
  letterSpacing: '-0.02em',
  fontVariantNumeric: 'tabular-nums',
  overflowWrap: 'anywhere',
})
export const slipTerms = style({ display: 'grid', gap: '10px', paddingInlineStart: '20px' })
