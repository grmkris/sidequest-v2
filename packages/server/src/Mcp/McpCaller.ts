import { Context, Effect, Option } from 'effect'
import type { AgentCaller } from '../Agents/AgentAccess.ts'

/** The agent an MCP request's bearer token let in, and the site the request came to (for links to the website). */
export interface Caller extends AgentCaller {
  readonly origin: string
}

/**
 * Who sent the MCP request being served, which `BearerAuth` provides on the request before the MCP server sees it.
 * The tool registry is shared by every request, so its handlers read the caller from the request instead of
 * capturing it; a reference with no caller by default keeps it out of their requirements.
 */
export const McpCaller = Context.Reference<Option.Option<Caller>>('Sidequest/McpCaller', {
  defaultValue: Option.none,
})

/** The caller of the tool call being served. Only `BearerAuth` routes reach the tools, so there always is one. */
export const currentCaller = Effect.gen(function* () {
  const caller = yield* McpCaller
  if (Option.isNone(caller)) return yield* Effect.die(new Error('An MCP tool ran without an authenticated caller'))
  return caller.value
})
