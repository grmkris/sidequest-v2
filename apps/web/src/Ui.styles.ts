import { style } from './zyzz.config.ts'

// Shared shapes: the page column, panels, fields, actions and notices.

/** A page's column: one reading measure, its parts spaced by section. */
export const page = style({ display: 'grid', gap: '32px', alignContent: 'start', minInlineSize: '0' })
export const pageHead = style({ display: 'grid', gap: '10px' })
export const lede = style({ color: 'ink2', fontSize: 'subheading', maxInlineSize: '60ch' })
export const section = style({ display: 'grid', gap: '16px', alignContent: 'start', minInlineSize: '0' })
export const sectionHead = style({
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: '8px 16px',
})

/** A raised surface for one thing: the request, a proposal, a form. */
export const panel = style({
  display: 'grid',
  gap: '16px',
  padding: 'clamp(16px, 4vw, 24px)',
  borderRadius: 'panel',
  backgroundColor: 'stock',
  boxShadow: 'lift',
  minInlineSize: '0',
})

/** A list of rows divided by hairlines. */
export const rows = style({ listStyle: 'none', display: 'grid', minInlineSize: '0' })
export const row = style({
  display: 'grid',
  gap: '4px',
  paddingBlock: '14px',
  borderBlockEndWidth: '1px',
  borderBlockEndStyle: 'solid',
  borderBlockEndColor: 'hairline',
  minInlineSize: '0',
  ':last-child': { borderBlockEndWidth: '0' },
})
export const rowTitle = style({ fontSize: 'subheading', fontWeight: 600, overflowWrap: 'anywhere' })
export const meta = style({ color: 'ink2', fontSize: 'label' })

/** Terms as a two-column list of names and values, one column on a phone. */
export const facts = style({
  display: 'grid',
  gridTemplateColumns: 'minmax(0, max-content) minmax(0, 1fr)',
  gap: '8px 20px',
  '@media (max-width: 479px)': { gridTemplateColumns: 'minmax(0, 1fr)', gap: '2px' },
})
export const factName = style({ color: 'ink2', fontSize: 'label' })
export const factValue = style({
  fontVariantNumeric: 'tabular-nums',
  overflowWrap: 'anywhere',
  '@media (max-width: 479px)': { marginBlockEnd: '8px' },
})
export const data = style({ fontFamily: 'data', fontSize: 'small', overflowWrap: 'anywhere' })

export const form = style({ display: 'grid', gap: '18px', minInlineSize: '0' })
export const field = style({ display: 'grid', gap: '6px', minInlineSize: '0' })
export const fieldRow = style({
  display: 'grid',
  gap: '18px',
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 150px), 1fr))',
})
export const label = style({ fontSize: 'label', fontWeight: 600 })
export const hint = style({ color: 'ink2', fontSize: 'small' })
export const fieldError = style({ color: 'danger', fontSize: 'small', fontWeight: 600 })
export const input = style({
  inlineSize: '100%',
  minBlockSize: '48px',
  paddingInline: '14px',
  borderWidth: '1px',
  borderStyle: 'solid',
  borderColor: 'rule',
  borderRadius: 'field',
  backgroundColor: 'stock',
  color: 'ink',
  fontSize: 'root',
  '&[aria-invalid="true"]': { borderColor: 'danger' },
})
export const textArea = style({ paddingBlock: '12px', lineHeight: 1.5, resize: 'vertical', minBlockSize: '120px' })
export const choices = style({
  display: 'flex',
  flexWrap: 'wrap',
  gap: '8px 18px',
  borderWidth: '0',
  padding: '0',
  margin: '0',
  minInlineSize: '0',
})
export const choice = style({ display: 'inline-flex', alignItems: 'center', gap: '8px', minBlockSize: '44px' })
export const legend = style({ fontSize: 'label', fontWeight: 600, padding: '0', marginBlockEnd: '4px' })

export const actions = style({ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px' })

/** The shape every action shares; combine with primary or secondary. */
export const pressable = style({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '8px',
  minBlockSize: '46px',
  paddingInline: '18px',
  borderRadius: 'pill',
  fontSize: 'label',
  fontWeight: 650,
  textDecorationLine: 'none',
  cursor: 'pointer',
  userSelect: 'none',
  WebkitUserSelect: 'none',
})

/** The one ink-filled action of a form or a panel. Works on links and buttons. */
export const primary = style({
  borderWidth: '0',
  backgroundColor: 'ink',
  color: 'onInk',
  '@media (prefers-reduced-motion: no-preference)': {
    transitionProperty: 'transform, background-color',
    transitionDuration: 'press',
    transitionTimingFunction: 'standard',
  },
  ':active': { transform: 'scale(0.97)' },
  '@media (hover: hover) and (pointer: fine)': { ':hover': { backgroundColor: 'inkHover' } },
  ':disabled': { opacity: 0.55, cursor: 'not-allowed', transform: 'none' },
})

/** An outlined action beside a primary one. */
export const secondary = style({
  borderWidth: '1.5px',
  borderStyle: 'solid',
  borderColor: 'ink',
  backgroundColor: 'transparent !custom',
  color: 'ink',
  ':active': { backgroundColor: 'wash' },
  '@media (hover: hover) and (pointer: fine)': { ':hover': { backgroundColor: 'wash' } },
  ':disabled': { opacity: 0.55, cursor: 'not-allowed' },
})

/** The action that signs money away: the seal's fill, used only on a signing slip. */
export const seal = style({ borderWidth: '0', backgroundColor: 'seal', color: 'onInk' })

/** An action that loses something: withdraw, revoke, reject. */
export const destructive = style({ borderColor: 'danger', color: 'danger' })

/** A button that reads as a link, for an action inside a line of text. */
export const linkButton = style({
  display: 'inline-flex',
  alignItems: 'center',
  minBlockSize: '44px',
  padding: '0',
  borderWidth: '0',
  backgroundColor: 'transparent !custom',
  color: 'signal',
  fontSize: 'inherit !custom',
  fontWeight: 600,
  textDecorationLine: 'underline',
  textDecorationThickness: '1.5px',
  textUnderlineOffset: '3px',
  cursor: 'pointer',
  ':disabled': { opacity: 0.55, cursor: 'not-allowed' },
})

/** A line that tells the person something happened or did not. */
export const notice = style({
  display: 'grid',
  gap: '8px',
  paddingBlock: '12px',
  paddingInline: '16px',
  borderRadius: 'field',
  borderInlineStartWidth: '4px',
  borderInlineStartStyle: 'solid',
  borderInlineStartColor: 'rule',
  backgroundColor: 'wash',
  '&[data-tone="danger"]': { borderInlineStartColor: 'danger', backgroundColor: 'dangerWash' },
  '&[data-tone="done"]': { borderInlineStartColor: 'done', backgroundColor: 'doneWash' },
})

/** Words that wait for data: the same height as the line that replaces them. */
export const waiting = style({ color: 'ink2', minBlockSize: '24px' })

/** A small status word: the job's stage, a version's standing. */
export const chip = style({
  display: 'inline-flex',
  alignItems: 'center',
  paddingInline: '8px',
  minBlockSize: '24px',
  borderRadius: 'chip',
  backgroundColor: 'wash',
  color: 'ink',
  fontSize: 'small',
  fontWeight: 600,
  whiteSpace: 'nowrap',
  '&[data-tone="done"]': { backgroundColor: 'doneWash', color: 'done' },
  '&[data-tone="danger"]': { backgroundColor: 'dangerWash', color: 'danger' },
  '&[data-tone="seal"]': { backgroundColor: 'sealWash', color: 'seal' },
})

export const visuallyHidden = style({
  position: 'absolute',
  inlineSize: '1px',
  blockSize: '1px',
  overflow: 'hidden',
  clipPath: 'inset(50%)',
  whiteSpace: 'nowrap',
})
