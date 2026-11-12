import { global } from 'zyzz/web'
import { vars } from './zyzz.config.ts'

// Document defaults. Component styles live in `*.styles.ts` beside the views that use them.
global({
  ':root': {
    colorScheme: 'light dark',
    fontFamily: vars.fontFamily.body,
    fontSize: vars.fontSize.body,
    backgroundColor: vars.color.paper,
    color: vars.color.ink,
    lineHeight: 1.5,
    fontSynthesis: 'none',
    WebkitFontSmoothing: 'antialiased',
    accentColor: vars.color.ink,
  },
  '*, ::before, ::after': { boxSizing: 'border-box' },
  html: {
    WebkitTextSizeAdjust: '100%',
    WebkitTapHighlightColor: 'transparent',
    scrollbarGutter: 'stable',
    overflowX: 'clip',
  },
  body: { margin: '0', minBlockSize: '100svh' },
  'h1, h2, h3, p, dl, dd, ul, ol, figure, blockquote': { margin: '0' },
  'ul, ol': { padding: '0' },
  'h1, h2, h3': { textWrap: 'balance', overflowWrap: 'break-word', minInlineSize: '0' },
  h1: { fontSize: vars.fontSize.title, lineHeight: 1.1, fontWeight: 650, letterSpacing: '-0.02em' },
  h2: { fontSize: vars.fontSize.heading, lineHeight: 1.25, fontWeight: 650, letterSpacing: '-0.01em' },
  h3: { fontSize: vars.fontSize.subheading, lineHeight: 1.3, fontWeight: 650 },
  'p, li, dd': { maxInlineSize: '68ch', textWrap: 'pretty', overflowWrap: 'anywhere' },
  a: {
    color: vars.color.signal,
    fontWeight: 600,
    textDecorationLine: 'underline',
    textDecorationThickness: '1.5px',
    textUnderlineOffset: '3px',
    touchAction: 'manipulation',
  },
  'button, select, input, textarea': {
    font: 'inherit',
    fontSize: vars.fontSize.root,
    color: 'inherit',
    touchAction: 'manipulation',
  },
  'button, select': { minBlockSize: '44px' },
  ':focus-visible': {
    outlineWidth: '2px',
    outlineStyle: 'solid',
    outlineColor: vars.color.focus,
    outlineOffset: '2px',
  },
  // After a route change the page's title takes focus for screen readers; a heading is not a control to ring.
  '#main h1:focus': { outlineWidth: '0' },
  '@media (prefers-reduced-motion: reduce)': {
    '*, ::before, ::after': {
      animationDuration: '0.01ms !important',
      animationIterationCount: '1 !important',
      transitionDuration: '0.01ms !important',
      scrollBehavior: 'auto !important',
    },
  },
})
