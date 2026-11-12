import { style } from '../zyzz.config.ts'

/** The two steps of signing in, in order; a finished one is struck through in the secondary ink. */
export const steps = style({
  display: 'grid',
  gap: '4px',
  paddingInlineStart: '22px',
  color: 'ink',
  fontWeight: 600,
  '& > li[data-done="true"]': { color: 'ink2', textDecorationLine: 'line-through' },
})
