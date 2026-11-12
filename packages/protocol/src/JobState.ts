import { Schema } from 'effect'

/**
 * Open → Awarded → Funded → Delivered → Settled, with Disputed between Delivered and Settled.
 * Cancelled and Expired are terminal.
 */
export const JobState = Schema.Literals([
  'Open',
  'Awarded',
  'Funded',
  'Delivered',
  'Disputed',
  'Settled',
  'Cancelled',
  'Expired',
])
export type JobState = typeof JobState.Type
