import { style } from '../zyzz.config.ts'

/** The agent being managed, set in below its row. */
export const panel = style({
  display: 'grid',
  gap: '24px',
  marginBlockStart: '12px',
  padding: 'clamp(14px, 3vw, 20px)',
  borderRadius: 'panel',
  backgroundColor: 'stock',
  boxShadow: 'lift',
})
/** A scope's checkbox, its name and what it allows, on one tap target. */
export const scope = style({
  display: 'grid',
  gridTemplateColumns: 'auto minmax(0, 1fr)',
  gap: '10px',
  alignItems: 'start',
  inlineSize: '100%',
  paddingBlock: '8px',
  '& > input': { inlineSize: '20px', blockSize: '20px', marginBlockStart: '2px' },
  '& > span': { display: 'grid', gap: '2px' },
})
