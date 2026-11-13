import { Schema } from 'effect'
import { EventId } from './Event.ts'
import type { KindSpec } from './KindSpec.ts'
import { sidequestKinds } from './Kinds.ts'
import { eventTag } from './RoutingTags.ts'

/** An operator ends one grant (kind 8419). Only the grant's own author can revoke it; the index checks that. */
export const GrantRevocationContent = Schema.Struct({ grant: EventId })
export type GrantRevocationContent = typeof GrantRevocationContent.Type

export const grantRevocation: KindSpec<GrantRevocationContent> = {
  kind: sidequestKinds.revocation,
  content: GrantRevocationContent,
  routing: (content) => [eventTag(content.grant)],
  network: 'none',
}
