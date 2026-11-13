import { Entropy, type EventTemplate, finalizeEvent, type NostrEvent, publicKeyOf, SecretKey } from '@sidequest/nostr'
import {
  agentGrant,
  buildSidequestEvent,
  grantRevocation,
  jobRequest,
  messagingRelaysTemplate,
  RelayUrl,
  relayListTemplate,
  standardKinds,
  walletLink,
  walletLinkTypedData,
} from '@sidequest/nostr/vocabulary'
import type { GrantScope } from '@sidequest/protocol'
import { Duration, Effect, Layer, Schema } from 'effect'
import type { Hex } from 'viem'
import { type PrivateKeyAccount, privateKeyToAccount } from 'viem/accounts'
import { defaultTiming, type IndexConfig, idleIndex, IndexSettings } from '../src/Index/IndexConfig.ts'
import { IndexLive } from '../src/Index/IndexLive.ts'
import { localSql } from './LocalSql.ts'

// Signed events for the index's tests, made with fixed keys and fixed signing randomness so failures reproduce, and the
// index on a fresh local D1.

export const keyOf = (hex: string) => Schema.decodeSync(SecretKey)(hex)
export const alice = keyOf('0beebd062ec8735f4243466049d7747ef5d6594ee838de147f8aab842b15e273')
export const bob = keyOf('e108399bd8424357a710b606ae0c13166d853d327e47a6e5e038197346bdbf45')
export const carol = keyOf('3333333333333333333333333333333333333333333333333333333333333333')
export const service = keyOf('4444444444444444444444444444444444444444444444444444444444444444')
const zeros = Schema.decodeSync(Entropy)(new Uint8Array(32))

/** Signs a template as `key`'s owner. */
export const signed = (template: EventTemplate, key: SecretKey = alice): NostrEvent =>
  finalizeEvent(template, key, zeros)

/** A kind-0 profile with this JSON content. */
export const profile = (key: SecretKey, createdAt: number, content: Record<string, unknown>) =>
  signed({ created_at: createdAt, kind: standardKinds.profile, tags: [], content: JSON.stringify(content) }, key)

const urls = (list: ReadonlyArray<string>) => list.map((url) => Schema.decodeSync(RelayUrl)(url))

/** A NIP-65 relay list. */
export const relayList = (
  key: SecretKey,
  createdAt: number,
  lists: { readonly read: ReadonlyArray<string>; readonly write: ReadonlyArray<string> },
) => signed(relayListTemplate({ read: urls(lists.read), write: urls(lists.write) }, createdAt), key)

/** A NIP-17 messaging relay list. */
export const messagingRelays = (key: SecretKey, createdAt: number, relays: ReadonlyArray<string>) =>
  signed(messagingRelaysTemplate(urls(relays), createdAt), key)

/** A Sidequest job request signed at `createdAt`. */
export const request = (key: SecretKey, createdAt: number, title = 'A logo') =>
  signed(
    Effect.runSync(
      buildSidequestEvent(
        jobRequest,
        { title, description: 'Small, warm.', expiresAt: createdAt + 86_400 },
        { createdAt },
      ),
    ),
    key,
  )

export const pubkeyOf = publicKeyOf

/** EVM wallets with fixed keys, and the chain their links name. */
export const walletOne = privateKeyToAccount(`0x${'61'.repeat(32)}`)
export const walletTwo = privateKeyToAccount(`0x${'62'.repeat(32)}`)
export const linkChain = 5_042_002

/** A wallet as the CAIP-10 account a link names, in lowercase. */
export const accountOf = (wallet: PrivateKeyAccount, chainId = linkChain) =>
  `eip155:${chainId}:${wallet.address.toLowerCase()}`

/** `wallet`'s EIP-712 signature linking `key`, made by viem as a wallet would (`eth_signTypedData_v4`). */
export const walletSignature = (wallet: PrivateKeyAccount, key: SecretKey, issuedAt: number, chainId = linkChain) => {
  const typed = walletLinkTypedData(publicKeyOf(key), issuedAt, chainId)
  return wallet.signTypedData({
    domain: typed.domain,
    types: { LinkNostrKey: typed.types.LinkNostrKey },
    primaryType: 'LinkNostrKey',
    message: { pubkey: `0x${publicKeyOf(key)}`, issuedAt: BigInt(issuedAt) },
  })
}

/** `key`'s link to `account`, carrying `signature` as the wallet's, signed at `issuedAt`. */
export const walletLinkEvent = (key: SecretKey, account: string, issuedAt: number, signature: Hex) =>
  signed(
    Effect.runSync(
      Effect.flatMap(
        Schema.decodeUnknownEffect(walletLink.content)({ address: account, issuedAt, walletSignature: signature }),
        (content) => buildSidequestEvent(walletLink, content, { createdAt: issuedAt }),
      ),
    ),
    key,
  )

/** `key`'s link to `wallet`, with the wallet's own signature. */
export const linked = async (key: SecretKey, wallet: PrivateKeyAccount, issuedAt: number, chainId = linkChain) =>
  walletLinkEvent(key, accountOf(wallet, chainId), issuedAt, await walletSignature(wallet, key, issuedAt, chainId))

/** `operator` lets `agent` act with `scopes` from `notBefore` until `expiresAt`, signed at `createdAt`. */
export const grant = (
  operator: SecretKey,
  agent: SecretKey,
  window: { readonly createdAt: number; readonly notBefore: number; readonly expiresAt: number },
  scopes: ReadonlyArray<GrantScope> = ['discuss', 'propose'],
  label = 'Helper',
) =>
  signed(
    Effect.runSync(
      Effect.flatMap(
        Schema.decodeUnknownEffect(agentGrant.content)({
          agent: publicKeyOf(agent),
          scopes,
          notBefore: window.notBefore,
          expiresAt: window.expiresAt,
          label,
        }),
        (content) => buildSidequestEvent(agentGrant, content, { createdAt: window.createdAt }),
      ),
    ),
    operator,
  )

/** `key` revokes the grant `grantId`, signed at `createdAt`. */
export const revocation = (key: SecretKey, grantId: string, createdAt: number) =>
  signed(
    Effect.runSync(
      Effect.flatMap(Schema.decodeUnknownEffect(grantRevocation.content)({ grant: grantId }), (content) =>
        buildSidequestEvent(grantRevocation, content, { createdAt }),
      ),
    ),
    key,
  )

/** Relay timing for tests: short waits, so a silent relay fails within the test's time. */
export const testTiming = {
  ...defaultTiming,
  connectTimeout: Duration.seconds(2),
  replyTimeout: Duration.millis(800),
}

/** An index that polls and relays to `relays` (local test relays allowed). */
export const relaying = (relays: ReadonlyArray<string>, overrides: Partial<IndexConfig> = {}): IndexConfig => ({
  ...idleIndex,
  relays,
  policy: 'local',
  timing: testTiming,
  ...overrides,
})

/** The index on a fresh local D1 with `config`; `sqlite` reads the database directly. */
export const indexWorld = (config: IndexConfig = idleIndex) => {
  const { sqlite, layer: sql } = localSql()
  const layer = IndexLive.pipe(Layer.provideMerge(Layer.succeed(IndexSettings, config)), Layer.provideMerge(sql))
  return { sqlite, layer }
}

/** The index's derived tables, in a fixed order, for comparing two databases. */
export const derivedTables = (sqlite: ReturnType<typeof localSql>['sqlite']) => ({
  profiles: sqlite.prepare('SELECT * FROM profiles ORDER BY pubkey').all(),
  relayLists: sqlite.prepare('SELECT * FROM relay_lists ORDER BY pubkey, kind').all(),
  walletLinks: sqlite.prepare('SELECT * FROM wallet_links ORDER BY event_id').all(),
  grants: sqlite.prepare('SELECT * FROM agent_grants ORDER BY event_id').all(),
  revocations: sqlite.prepare('SELECT * FROM grant_revocations ORDER BY event_id').all(),
})
