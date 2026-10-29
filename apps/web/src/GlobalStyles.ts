import { global } from 'zyzz/web'
import { vars } from './zyzz.config.ts'

global({
  ':root': {
    colorScheme: 'light',
    fontFamily: vars.fontFamily.body,
    backgroundColor: vars.color.paper,
    color: vars.color.ink,
    lineHeight: 1.5,
    fontSynthesis: 'none',
    WebkitFontSmoothing: 'antialiased',
  },
  '*': { boxSizing: 'border-box' },
  body: { margin: '0' },
  'h1, p': { margin: '0' },
  h1: { fontSize: 'clamp(36px, 8vw, 64px)', lineHeight: 1.05, letterSpacing: '-0.03em' },
  p: { maxInlineSize: '60ch' },
  button: { font: 'inherit', minBlockSize: '44px', touchAction: 'manipulation' },
  ':focus-visible': { outline: '2px solid', outlineColor: vars.color.focus, outlineOffset: '3px' },
  '@media (prefers-reduced-motion: reduce)': {
    '*': { animationDuration: '0.01ms !important', transitionDuration: '0.01ms !important' },
  },
})
