import { Toolkit } from 'effect/ai'
import { AccountTools } from './Account.ts'
import { DirectoryTools } from './Directory.ts'
import { JobTools } from './Jobs.ts'
import { RoomTools } from './Rooms.ts'

/**
 * Every tool an agent reaches over MCP: the same commands and reads as the HTTP API, as its operator, within its
 * grant. Steps that need the person (funding, signing on chain, approving or rejecting a delivery) are not tools; a
 * tool names them as a `nextAction` on the website.
 */
export const AgentToolkit = Toolkit.merge(AccountTools, DirectoryTools, JobTools, RoomTools)
