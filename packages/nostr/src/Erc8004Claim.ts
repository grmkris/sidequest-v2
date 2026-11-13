import { Schema } from 'effect'
import type { KindSpec } from './KindSpec.ts'
import { sidequestKinds } from './Kinds.ts'
import { PublicKey } from './PublicKey.ts'
import { personTag } from './RoutingTags.ts'
import { EvmAccount, networkOfAccount } from './WalletLink.ts'

const uint256Limit = 2n ** 256n

/**
 * An ERC-8004 `agentId`: the identity registry's ERC-721 token id, a `uint256`, as its decimal digits with no leading
 * zero (JSON numbers lose precision past 2⁵³).
 */
export const Erc8004AgentId = Schema.String.check(
  Schema.isPattern(/^(?:0|[1-9][0-9]{0,77})$/u),
  Schema.makeFilter((digits) => BigInt(digits) < uint256Limit, { expected: 'uint256' }),
)
export type Erc8004AgentId = typeof Erc8004AgentId.Type

/** An MCP endpoint a claim advertises: an `https` URL. */
const McpEndpoint = Schema.String.check(Schema.isMaxLength(2000), Schema.isPattern(/^https:\/\/[^\s]+$/u))

/**
 * The owner of an ERC-8004 identity says which Nostr key it stands for (ADR-0007, decision 5): `subject` (the author
 * themselves, or an agent they granted), the identity registry as CAIP-10 on its chain, the token's `agentId`, and
 * optionally the MCP endpoint the agent answers at. The `p` tag is the subject, and the registry's chain is the event's
 * network. Whether the author's linked wallet owns the token, and whether its `agentURI` is the subject's registration
 * file, is the index's to check on chain; this reader checks only what the event says.
 */
export const Erc8004ClaimContent = Schema.Struct({
  subject: PublicKey,
  registry: EvmAccount,
  agentId: Erc8004AgentId,
  mcp: Schema.optionalKey(McpEndpoint),
})
export type Erc8004ClaimContent = typeof Erc8004ClaimContent.Type

export const erc8004Claim: KindSpec<Erc8004ClaimContent> = {
  kind: sidequestKinds.erc8004Claim,
  content: Erc8004ClaimContent,
  routing: (content) => [personTag(content.subject)],
  network: (content) => networkOfAccount(content.registry),
}
