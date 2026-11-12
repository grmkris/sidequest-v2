import { style } from '../zyzz.config.ts'

/** The opening: Sidequest in two sentences and the two ways in. */
export const hero = style({
  display: 'grid',
  gap: '16px',
  paddingBlockStart: 'clamp(8px, 4vw, 32px)',
  borderBlockEndWidth: '1px',
  borderBlockEndStyle: 'solid',
  borderBlockEndColor: 'hairline',
  paddingBlockEnd: '32px',
})
export const heroTitle = style({
  fontSize: 'display',
  lineHeight: 1.02,
  letterSpacing: '-0.03em',
  maxInlineSize: '16ch',
})
export const tags = style({ listStyle: 'none', display: 'flex', flexWrap: 'wrap', gap: '6px', marginBlockStart: '4px' })
export const search = style({
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) auto',
  gap: '10px',
  alignItems: 'center',
})
