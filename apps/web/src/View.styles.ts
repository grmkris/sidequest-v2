import { style } from './zyzz.config.ts'

/** One column a reading measure wide, with a 16px gutter on a phone and room to breathe on a wide screen. */
export const shell = style({
  display: 'grid',
  gridTemplateRows: 'auto 1fr auto',
  minBlockSize: '100svh',
  paddingInline: 'max(16px, env(safe-area-inset-left))',
})
export const skip = style({
  position: 'absolute',
  insetInlineStart: '16px',
  insetBlockStart: '-48px',
  padding: '10px 14px',
  borderRadius: 'field',
  backgroundColor: 'ink',
  color: 'onInk',
  zIndex: 10,
  ':focus': { insetBlockStart: '12px' },
})
export const header = style({
  inlineSize: '100%',
  maxInlineSize: '1120px',
  marginInline: 'auto',
  display: 'grid',
  gap: '6px',
  paddingBlock: 'max(14px, env(safe-area-inset-top)) 10px',
  borderBlockEndWidth: '1px',
  borderBlockEndStyle: 'solid',
  borderBlockEndColor: 'hairline',
})
export const bar = style({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '12px',
  minBlockSize: '44px',
})
/** The wordmark: the name set tight and heavy, in ink; the one piece of type with character. */
export const brand = style({
  color: 'ink',
  fontSize: 'heading',
  fontWeight: 800,
  letterSpacing: '-0.04em',
  textDecorationLine: 'none',
  minBlockSize: '44px',
  display: 'inline-flex',
  alignItems: 'center',
})
/** The session's corner keeps one height whatever it says, so nothing moves when the session is read. */
export const session = style({
  display: 'flex',
  alignItems: 'center',
  gap: '14px',
  minBlockSize: '44px',
  minInlineSize: '0',
})
export const nav = style({ display: 'flex', flexWrap: 'wrap', gap: '4px 18px' })
export const navLink = style({
  display: 'inline-flex',
  alignItems: 'center',
  minBlockSize: '44px',
  color: 'ink2',
  fontSize: 'label',
  fontWeight: 600,
  textDecorationLine: 'none',
  '&[aria-current="page"]': { color: 'ink', textDecorationLine: 'underline', textDecorationColor: 'signal' },
  '@media (hover: hover) and (pointer: fine)': { ':hover': { color: 'ink' } },
})
export const main = style({
  inlineSize: '100%',
  maxInlineSize: '1120px',
  marginInline: 'auto',
  display: 'grid',
  gap: '20px',
  alignContent: 'start',
  paddingBlock: '28px 56px',
})
export const footer = style({
  inlineSize: '100%',
  maxInlineSize: '1120px',
  marginInline: 'auto',
  display: 'grid',
  gap: '4px',
  paddingBlock: '20px max(20px, env(safe-area-inset-bottom))',
  borderBlockStartWidth: '1px',
  borderBlockStartStyle: 'solid',
  borderBlockStartColor: 'hairline',
  color: 'ink2',
  fontSize: 'small',
})
