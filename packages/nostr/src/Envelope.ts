import { NetworkRef } from '@sidequest/protocol'
import { Option, Schema } from 'effect'
import { EventId, type NostrEvent, type Tag } from './Event.ts'
import { envelopeTag, vocabularyVersion } from './Kinds.ts'

/**
 * What a Sidequest event says around its content: the network it binds money on (`["sq-net", <CAIP-2>]`) and, when an
 * agent signed it, the grant it acts under (`["sq-grant", <grant event id>]`).
 */
export interface Envelope {
  readonly network: Option.Option<NetworkRef>
  readonly grant: Option.Option<EventId>
}

/** The envelope's tags: the vocabulary version always, the network and the grant when present. */
export const envelopeTags = (envelope: Envelope): ReadonlyArray<Tag> => [
  [envelopeTag.version, vocabularyVersion],
  ...Option.toArray(Option.map(envelope.network, (network) => [envelopeTag.network, network])),
  ...Option.toArray(Option.map(envelope.grant, (grant) => [envelopeTag.grant, grant])),
]

/** The value of the event's only `[name, value]` tag: `None` if it has none, `undefined` if it has several. */
const onlyValue = (event: NostrEvent, name: string): Option.Option<string> | undefined => {
  const found = event.tags.filter((tag) => tag[0] === name)
  if (found.length === 0) return Option.none()
  return found.length === 1 ? Option.fromNullishOr(found[0]?.[1]) : undefined
}

const decodeAs =
  <A>(schema: Schema.Codec<A, string>) =>
  (value: Option.Option<string> | undefined): Option.Option<A> | undefined => {
    if (value === undefined) return undefined
    if (Option.isNone(value)) return Option.none()
    const decoded = Schema.decodeUnknownOption(schema)(value.value)
    return Option.isSome(decoded) ? decoded : undefined
  }

const networkValue = decodeAs(NetworkRef)
const grantValue = decodeAs(EventId)

/**
 * Reads the envelope, or `undefined` when it is malformed: the version tag missing, repeated or not `"2"`, or a
 * network or grant tag repeated or not decoding.
 */
export const readEnvelope = (event: NostrEvent): Envelope | undefined => {
  const version = onlyValue(event, envelopeTag.version)
  const network = networkValue(onlyValue(event, envelopeTag.network))
  const grant = grantValue(onlyValue(event, envelopeTag.grant))
  if (version === undefined || !Option.contains(version, vocabularyVersion)) return undefined
  return network === undefined || grant === undefined ? undefined : { network, grant }
}

/** The grant an agent-signed event acts under, if it names one well-formed grant. */
export const grantOf = (event: NostrEvent): Option.Option<EventId> =>
  grantValue(onlyValue(event, envelopeTag.grant)) ?? Option.none()

const tagKey = (tag: Tag) => JSON.stringify(tag)

/** Whether two tag lists hold the same tags, ignoring order: relays and indexes never depend on tag order. */
export const sameTags = (left: ReadonlyArray<Tag>, right: ReadonlyArray<Tag>): boolean => {
  if (left.length !== right.length) return false
  const sortedLeft = left.map(tagKey).toSorted()
  const sortedRight = right.map(tagKey).toSorted()
  return sortedLeft.every((key, index) => key === sortedRight[index])
}
