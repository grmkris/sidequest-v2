import { encodeNpub, PublicKey } from '@sidequest/nostr'
import {
  type Erc8004Identity,
  type Erc8004Registration,
  type Erc8004Service,
  erc8004RegistrationType,
  type SidequestRegistrationFile,
} from '@sidequest/protocol'
import { statelessRevision } from '@sidequest/serving/Revisions'
import { Option, Schema } from 'effect'
import { grantStatus, type WalletLinkRow } from '../Index/Derived.ts'
import type { Known, KnownGrant } from '../Index/EventStore.ts'

// The agent registration file an ERC-8004 identity's `agentURI` resolves to (ADR-0007, decision 4), built by the
// index from signed events: the key's profile, the operator whose unrevoked grant lets it act, the operator's linked
// wallets, the MCP endpoint the operator's claim names, the verified registrations, and where the key's feedback is.

/** Where a key's feedback file is, on the same origin as its registration file. */
export const feedbackPath = (pubkey: string) => `/api/erc8004/agents/${pubkey}/feedback`

/** The registrations to list: verified ones whose `agentId` JSON carries exactly (any registry counts from 0). */
export const registrationsOf = (identities: ReadonlyArray<Erc8004Identity>): ReadonlyArray<Erc8004Registration> =>
  identities.flatMap((identity) => {
    const agentId = Number(identity.agentId)
    return identity.status === 'verified' && Number.isSafeInteger(agentId)
      ? [{ agentId, agentRegistry: identity.registry }]
      : []
  })

/** Who the key acts for, when it is an agent: its operator, the grant, and the operator's current wallets. */
export interface Operating {
  readonly grant: KnownGrant
  readonly wallets: ReadonlyArray<WalletLinkRow>
}

/**
 * The operator a file names: the author of the key's first verified claim that is not the key itself, else of its
 * newest unrevoked grant received. `None` for a person who registered as themselves and acts for nobody.
 */
export const operatorOf = (known: Known, identities: ReadonlyArray<Erc8004Identity>): Option.Option<string> => {
  const claimed = identities.find((identity) => identity.status === 'verified')?.claimedBy
  const granted = known.operators[0]?.operator
  return Option.fromUndefinedOr(claimed ?? granted)
}

const shortNpub = (pubkey: string) =>
  Option.match(Schema.decodeUnknownOption(PublicKey)(pubkey), {
    onNone: () => pubkey.slice(0, 12),
    onSome: (key) => `${encodeNpub(key).slice(0, 14)}…`,
  })

const nostrService = (pubkey: string): ReadonlyArray<Erc8004Service> =>
  Option.match(Schema.decodeUnknownOption(PublicKey)(pubkey), {
    onNone: () => [],
    onSome: (key) => [{ name: 'nostr', endpoint: `nostr:${encodeNpub(key)}` }],
  })

/** What the file is built from. `operating` is the key's operator's, for an agent; `None` for a person. */
export interface RegistrationInput {
  readonly pubkey: string
  readonly origin: string
  readonly known: Known
  readonly identities: ReadonlyArray<Erc8004Identity>
  readonly operating: Option.Option<Operating>
  readonly now: number
}

/** The file. Pure: the same facts, the same file. */
export const registrationFileOf = (input: RegistrationInput): SidequestRegistrationFile => {
  const { pubkey, origin, known, identities, operating, now } = input
  const profile = Option.getOrUndefined(known.profile)
  const grant = Option.getOrUndefined(Option.map(operating, (found) => found.grant))
  const wallets = Option.match(operating, { onNone: () => known.wallets, onSome: (found) => found.wallets })
  const mcp = identities.find(
    (identity) => identity.mcp !== null && (identity.claimedBy === pubkey || identity.claimedBy === grant?.operator),
  )?.mcp
  const name = profile?.name ?? grant?.label ?? `Sidequest ${shortNpub(pubkey)}`
  const description =
    profile?.about ??
    (grant === undefined
      ? 'A person on Sidequest, whose reviews are counted only on escrowed jobs that settled.'
      : `An agent on Sidequest acting for ${shortNpub(grant.operator)} under a signed grant (${grant.scopes.join(', ')}).`)
  const services: ReadonlyArray<Erc8004Service> = [
    ...(mcp === undefined || mcp === null ? [] : [{ name: 'MCP', endpoint: mcp, version: statelessRevision }]),
    ...nostrService(pubkey),
    ...wallets.map((wallet) => ({ name: 'wallet', endpoint: wallet.account })),
  ]
  return {
    type: erc8004RegistrationType,
    name,
    description,
    ...(profile?.picture === null || profile?.picture === undefined ? {} : { image: profile.picture }),
    services,
    x402Support: false,
    active: grant === undefined || grantStatus(grant, now) === 'active',
    registrations: registrationsOf(identities),
    supportedTrust: ['reputation'],
    sidequest: {
      pubkey,
      ...(grant === undefined ? {} : { operator: grant.operator, grant: grant.eventId }),
      feedback: `${origin}${feedbackPath(pubkey)}`,
    },
  }
}
