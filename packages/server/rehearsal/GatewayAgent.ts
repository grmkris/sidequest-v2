import type { PublicKey } from '@sidequest/nostr'
import { agentGrant } from '@sidequest/nostr/vocabulary'
import type { GrantScope } from '@sidequest/protocol'
import { Schema } from 'effect'
import { authorized, connectOverOAuth, createAgent, json, signedBy } from './GatewayClient.ts'
import { anyone, type NostrPerson } from './Nostr.ts'
import { Refused, toolsAt } from './Surfaces.ts'

// An agent at the gateway, as its operator sets it up and an MCP client then uses it: the operator (a person's Nostr
// key) makes the agent at the gateway (NIP-98), signs its grant and publishes it through the core, and consents to an
// MCP client over OAuth; the client calls the gateway's tools with the access token. The operator also stores a
// delivery delegation their wallet signed at the gateway, after which the agent records a delivery unattended.

export interface GatewayAgent {
  /** The agent's own Nostr key, made and held by the gateway; the rehearsal never sees its secret. */
  readonly pubkey: PublicKey
  /** The grant event its operator signed, which every event the agent signs names. */
  readonly grant: string
  readonly scopes: ReadonlyArray<GrantScope>
  /** The agent key's EVM address, which the operator's wallet names as the delivery delegate (the gateway's answer). */
  readonly delegate: `0x${string}`
  /** One tool call through an MCP client over OAuth; answers its structured content, and throws on a refusal. */
  readonly call: (tool: string, args: Record<string, unknown>) => Promise<unknown>
  /** The operator stores, at the gateway, the delivery delegation their wallet signed for `job`. */
  readonly storeDelegation: (job: string, signature: string, expiry: number) => Promise<void>
}

const Delegate = Schema.Struct({ delegate: Schema.TemplateLiteral(['0x', Schema.String]) })

/**
 * `operator` makes an agent at the gateway, grants it `scopes` for six hours and connects an MCP client to it. The
 * operator API is called at `operatorApi`: the gateway's own URL, or the core's `/gateway` proxy, which is how the
 * website reaches it on a stage with a site domain (the gateway accepts NIP-98 signed for either).
 */
export const gatewayAgent = async (
  coreUrl: string,
  gatewayUrl: string,
  operator: NostrPerson,
  scopes: ReadonlyArray<GrantScope>,
  operatorApi = gatewayUrl,
): Promise<GatewayAgent> => {
  const label = `${operator.name}’s agent`
  const agent = await createAgent(operatorApi, operator.key, label)
  const now = Math.floor(Date.now() / 1000)
  const grant = await signedBy(operator.key, agentGrant, {
    agent,
    scopes,
    notBefore: now - 60,
    expiresAt: now + 6 * 3600,
    label,
  })
  await anyone(coreUrl).publish(grant)
  const tokens = await connectOverOAuth(gatewayUrl, operator.key, agent)
  const delegations = `${operatorApi}/api/agents/${agent}/delegations`
  const shown = await authorized(operator.key, delegations, 'GET')
  const { delegate } = Schema.decodeUnknownSync(Delegate)(await json(shown))
  return {
    pubkey: agent,
    grant: grant.id,
    scopes,
    delegate,
    ...toolsAt(gatewayUrl, tokens.access_token),
    storeDelegation: async (job, signature, expiry) => {
      const stored = await authorized(operator.key, delegations, 'POST', JSON.stringify({ job, signature, expiry }))
      if (stored.status !== 201)
        throw new Refused({ message: `delegation: ${stored.status} ${JSON.stringify(await json(stored))}` })
    },
  }
}
