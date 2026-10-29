import { style, vars } from './zyzz.config.ts'

export const shell = style({ minBlockSize: '100svh', display: 'grid', placeItems: 'center', padding: '24px' })
export const card = style({
  display: 'grid',
  gap: '24px',
  inlineSize: 'min(100%, 720px)',
  padding: 'clamp(24px, 6vw, 64px)',
  borderRadius: 'panel',
  backgroundColor: 'stock',
  boxShadow: '0 18px 60px rgb(23 32 42 / 0.08)',
})
export const actions = style({ display: 'flex', flexWrap: 'wrap', gap: '12px' })
export const button = style({
  border: '0',
  borderRadius: 'pill',
  paddingInline: '20px',
  backgroundColor: 'signal',
  color: 'onInk',
  cursor: 'pointer',
})
export const secondary = style({
  border: '1px solid',
  borderColor: 'rule',
  borderRadius: 'pill',
  paddingInline: '20px',
  backgroundColor: 'transparent !custom',
  color: vars.color.ink,
  cursor: 'pointer',
})
