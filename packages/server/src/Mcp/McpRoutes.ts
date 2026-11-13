import { AgentToolkit } from '@sidequest/protocol'
import { Layer } from 'effect'
import { McpProtocol, McpServer } from 'effect/ai'
import { mcpPath } from '@sidequest/serving/Endpoints'
import { BearerAuth } from './BearerAuth.ts'
import { AccountHandlers } from './Tools/AccountHandlers.ts'
import { DirectoryHandlers } from './Tools/DirectoryHandlers.ts'
import { JobHandlers } from './Tools/JobHandlers.ts'
import { RoomHandlers } from './Tools/RoomHandlers.ts'

const instructions = [
  'Sidequest is a marketplace where people hire each other for work, paid through an on-chain escrow.',
  'You act as an agent for one person, your operator: everything you do is on their behalf, within the scopes',
  '(discuss, propose, accept, deliver) and expiry of the grant they gave you. Call `whoami` to see them.',
  'You never pay or sign: when funding, signing a delivery or reviewing one is due, tools return a `nextAction`',
  'with a link for the person. Refusals come back as tool errors naming the rule (`reason`) and its `evidence`.',
].join(' ')

/** Every tool's handler: one Layer per area of the toolkit. */
const ToolHandlers = Layer.mergeAll(AccountHandlers, DirectoryHandlers, JobHandlers, RoomHandlers)

/**
 * The MCP endpoint: stateless Streamable HTTP, as MCP revision 2026-07-28 defines it (no `initialize`, no session;
 * every request carries its own protocol version and client capabilities), so each POST runs its own server in the
 * request's scope and any Worker isolate can answer any request. Clients on the older revisions 2025-11-25 and
 * 2025-06-18 are served in front of it without sessions (`Revisions.ts`), by the same toolkit and handlers.
 * Requests from a browser page (with `Origin`) are refused, and every request must carry an agent's bearer token
 * ({@link BearerAuth}). The tools are {@link AgentToolkit}, registered once and shared by every request.
 */
export const mcpRoutes = (release: string) =>
  Layer.mergeAll(
    McpServer.layerHttpRequestScoped({
      name: 'sidequest',
      version: release,
      instructions,
      path: mcpPath,
      protocols: [McpProtocol.v2026_07_28],
    }).pipe(Layer.provide(BearerAuth.layer)),
    McpServer.toolkit(AgentToolkit).pipe(Layer.provide(ToolHandlers)),
  )
