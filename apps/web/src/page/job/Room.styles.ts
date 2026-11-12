import { style } from '../../zyzz.config.ts'

/** The conversation, oldest at the top; the person's own messages sit on a quiet wash. */
export const messages = style({
  listStyle: 'none',
  display: 'grid',
  gap: '10px',
  maxBlockSize: '28rem',
  overflowY: 'auto',
  overscrollBehavior: 'contain',
  paddingInlineEnd: '4px',
})
export const message = style({
  display: 'grid',
  gap: '2px',
  paddingBlock: '10px',
  paddingInline: '12px',
  borderRadius: 'field',
  borderWidth: '1px',
  borderStyle: 'solid',
  borderColor: 'hairline',
  '&[data-mine="true"]': { backgroundColor: 'wash', borderColor: 'wash' },
})
export const author = style({ color: 'ink2', fontSize: 'small', fontWeight: 600 })
export const text = style({ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' })
export const tabs = style({ display: 'flex', flexWrap: 'wrap', gap: '6px' })
export const tab = style({
  minBlockSize: '40px',
  paddingInline: '12px',
  borderRadius: 'pill',
  borderWidth: '1px',
  borderStyle: 'solid',
  borderColor: 'rule',
  backgroundColor: 'transparent !custom',
  color: 'ink',
  fontSize: 'label',
  fontWeight: 600,
  cursor: 'pointer',
  '&[aria-pressed="true"]': { backgroundColor: 'ink', borderColor: 'ink', color: 'onInk' },
})
