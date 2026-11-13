import type { NetworkRef } from '@sidequest/protocol'
import type { Effect, Schema } from 'effect'
import type { Tag } from './Event.ts'
import type { SidequestKind } from './Kinds.ts'

/**
 * Whether a kind binds money on a network: `none`, `required` (the author names it in `sq-net`), or a function that
 * derives it from the content, which `sq-net` must then equal.
 */
export type NetworkRule<C> = 'none' | 'required' | ((content: C) => NetworkRef)

/**
 * One Sidequest kind: its content schema (the content is that schema's JSON), the routing tags its content implies,
 * its network rule, and any check of the content beyond its schema. Building and parsing both derive the tags from
 * here, so an event whose tags say something its content does not is refused.
 */
export interface KindSpec<C> {
  readonly kind: SidequestKind
  readonly content: Schema.Codec<C, unknown>
  readonly routing: (content: C) => ReadonlyArray<Tag>
  readonly network: NetworkRule<C>
  readonly check?: (content: C) => Effect.Effect<boolean>
}
