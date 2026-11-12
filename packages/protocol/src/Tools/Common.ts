import { Context, Schema } from 'effect'
import { Tool } from 'effect/ai'
import { maxPageSize } from '../Page.ts'
import { BadCursor, Conflict, Forbidden, NotFound, Unprocessable } from '../Refusals.ts'
import { Unavailable } from '../SessionApi.ts'

/**
 * How a tool refuses: the same errors, reasons and evidence the HTTP API answers with (`{ _tag, reason, evidence }`),
 * so an agent reads a refusal the way a website would. The tool result carries it with `isError: true`.
 */
export const ToolRefusal = Schema.Union([Forbidden, NotFound, Conflict, Unprocessable, BadCursor, Unavailable])

/** How many items a tool returns at most, from 1 to 50 (default 20). */
export const ToolLimit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: maxPageSize })).annotate({
  description: `How many items to return, 1 to ${maxPageSize}; 20 when omitted.`,
})

/**
 * A step only the person can take, on the Sidequest website: funding the escrow, signing the delivery's hash, or
 * approving or rejecting a delivery. Agents never pay or sign. `url` is the page where the person does it.
 */
export const NextAction = Schema.Struct({
  kind: Schema.Literals(['fund_escrow', 'sign_delivery', 'review_delivery']),
  actor: Schema.Literal('person'),
  url: Schema.String,
  description: Schema.String,
})
export type NextAction = typeof NextAction.Type

/**
 * The hints of a tool that only reads: it changes nothing, repeating it is harmless, it reaches nothing outside. Like
 * every tool, its input is strict: a property its schema does not name is refused, not ignored.
 */
export const reading = Context.make(Tool.Readonly, true).pipe(
  Context.add(Tool.Strict, true),
  Context.add(Tool.Destructive, false),
  Context.add(Tool.Idempotent, true),
  Context.add(Tool.OpenWorld, false),
)

/**
 * The hints of a tool that records something in Sidequest: `idempotent` when repeating it with the same input records
 * nothing more, `destructive` when what it records cannot be undone and closes other paths (accepting a proposal).
 */
export const writing = ({ idempotent = false, destructive = false } = {}) =>
  Context.make(Tool.Readonly, false).pipe(
    Context.add(Tool.Strict, true),
    Context.add(Tool.Destructive, destructive),
    Context.add(Tool.Idempotent, idempotent),
    Context.add(Tool.OpenWorld, false),
  )
