import { Schema } from 'effect'

/** The cursor is not one this server gave out for this list. */
export class BadCursor extends Schema.TaggedError<BadCursor>()('BadCursor', {}, { httpApiStatus: 400 }) {}

/** Something the server depends on (its database, the chain) did not answer; the request may be retried. */
export class Unavailable extends Schema.TaggedError<Unavailable>()('Unavailable', {}, { httpApiStatus: 503 }) {}
