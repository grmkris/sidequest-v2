import { Context, Schema } from 'effect'
import { Tool } from 'effect/ai'
import { maxPageSize } from './Page.ts'

// What the agent gateway's MCP tools share: their page size and their hints.

/** How many items a tool returns at most, from 1 to 50 (default 20). */
export const ToolLimit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: maxPageSize })).annotate({
  description: `How many items to return, 1 to ${maxPageSize}; 20 when omitted.`,
})

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
