import { JobView } from '@sidequest/fold'
import {
  Entropy,
  type EventTemplate,
  finalizeEvent,
  httpAuthHeader,
  httpAuthTemplate,
  type NostrEvent,
  type PublicKey,
  publicKeyOf,
  SecretKey,
} from '@sidequest/nostr'
import {
  buildSidequestEvent,
  deliveryNote,
  jobAccept,
  jobProposal,
  jobRequest,
  type KindSpec,
  statement,
  walletLink,
  walletLinkTypedData,
} from '@sidequest/nostr/vocabulary'
import { type NetworkRef, Published, Terms, termsDigest, textDigest, UsdcOnArcTestnet } from '@sidequest/protocol'
import { Effect, Schema } from 'effect'
import type { Hex } from 'viem'
import { generatePrivateKey, type PrivateKeyAccount, privateKeyToAccount } from 'viem/accounts'
import { bodyOf, eventually, type Reply } from './Surfaces.ts'

// A person, over the public surfaces only: a Nostr key that signs events, published through
// `POST /api/events`, and a wallet linked to that key that signs only money. No sign-in, no session, no cookie.

const arc = UsdcOnArcTestnet.network
const chainId = 5042002

export interface NostrPerson {
  readonly name: string
  readonly key: SecretKey
  readonly pubkey: PublicKey
  readonly wallet: PrivateKeyAccount
  /** The wallet as CAIP-10 on Arc, in lowercase as links and `payTo` carry it. */
  readonly account: string
}

/** A fresh Nostr key, and the wallet `walletKey` (a fresh one without). */
export const nostrPerson = (name: string, walletKey: Hex = generatePrivateKey()): NostrPerson => {
  const key = Schema.decodeSync(SecretKey)(generatePrivateKey().slice(2))
  const wallet = privateKeyToAccount(walletKey)
  return { name, key, pubkey: publicKeyOf(key), wallet, account: `${arc}:${wallet.address.toLowerCase()}` }
}

const entropy = () => Schema.decodeSync(Entropy)(crypto.getRandomValues(new Uint8Array(32)))

const now = () => Math.floor(Date.now() / 1000)

const signed = <C>(person: NostrPerson, spec: KindSpec<C>, content: unknown, network?: NetworkRef) =>
  Effect.runPromise(
    Schema.decodeUnknownEffect(spec.content)(content).pipe(
      Effect.flatMap((decoded) =>
        buildSidequestEvent(
          spec,
          decoded,
          network === undefined ? { createdAt: now() } : { createdAt: now(), network },
        ),
      ),
      Effect.map((template: EventTemplate) => finalizeEvent(template, person.key, entropy())),
    ),
  )

/** What a person can sign about a job. */
export const sign = {
  /** The person's wallet links itself to their key: the wallet's EIP-712 signature inside the key's event. */
  link: async (person: NostrPerson) => {
    const issuedAt = now()
    const typed = walletLinkTypedData(person.pubkey, issuedAt, chainId)
    const walletSignature = await person.wallet.signTypedData({
      domain: typed.domain,
      types: { LinkNostrKey: typed.types.LinkNostrKey },
      primaryType: 'LinkNostrKey',
      message: { pubkey: `0x${person.pubkey}`, issuedAt: BigInt(issuedAt) },
    })
    return signed(person, walletLink, { address: person.account, issuedAt, walletSignature })
  },
  request: (buyer: NostrPerson, title: string) =>
    signed(buyer, jobRequest, { title, description: 'A logo for a café, as SVG.', expiresAt: now() + 86_400 }),
  proposal: async (worker: NostrPerson, request: NostrEvent, terms: Terms) =>
    signed(worker, jobProposal, {
      job: request.id,
      buyer: request.pubkey,
      terms: Schema.encodeSync(Terms)(terms),
      termsDigest: await Effect.runPromise(termsDigest(terms)),
      payTo: worker.account,
      validUntil: now() + 86_400,
    }),
  accept: (buyer: NostrPerson, request: NostrEvent, proposal: NostrEvent, terms: Terms, worker: PublicKey) =>
    Effect.runPromise(termsDigest(terms)).then((digest) =>
      signed(buyer, jobAccept, { job: request.id, proposal: proposal.id, termsDigest: digest, worker }, arc),
    ),
  note: (worker: NostrPerson, request: NostrEvent, deliveryHash: Hex) =>
    signed(
      worker,
      deliveryNote,
      { job: request.id, buyer: request.pubkey, deliveryHash, url: 'https://files.example/logo.svg' },
      arc,
    ),
  rejectionReason: (buyer: NostrPerson, request: NostrEvent) =>
    signed(buyer, statement, { job: request.id, type: 'rejection_reason', text: 'The favicon set is missing.' }),
}

const send = async (url: string, method: string, path: string, body?: string, headers: Record<string, string> = {}) => {
  const response = await fetch(`${url}${path}`, {
    method,
    headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body }),
  })
  const text = await response.text()
  const reply: Reply = { status: response.status, body: text === '' ? null : JSON.parse(text) }
  return reply
}

/** Requests with no cookie and no `Origin`: a script, an agent or another site's page could send them alike. */
export const anyone = (url: string) => ({
  get: (path: string) => send(url, 'GET', path),
  post: (path: string, body: unknown) => send(url, 'POST', path, JSON.stringify(body)),
  /** Publishes a signed event through the index. */
  publish: async (event: NostrEvent) =>
    bodyOf(Published, await send(url, 'POST', '/api/events', JSON.stringify(event)), `publish ${event.kind}`),
  /**
   * Posts `body` with a NIP-98 authorization by `key` for exactly this URL, method and body: the ruling's only
   * credential.
   */
  postAuthorized: async (path: string, body: unknown, key: SecretKey) => {
    const text = JSON.stringify(body)
    const payloadSha256 = await Effect.runPromise(textDigest(text))
    const template = httpAuthTemplate({ url: `${url}${path}`, method: 'POST', payloadSha256 }, now())
    return send(url, 'POST', path, text, { authorization: httpAuthHeader(finalizeEvent(template, key, entropy())) })
  },
})

/** The index's fold of `job`, once it shows what `done` waits for. */
export const foldedJob = (url: string, job: string, done: (view: JobView) => boolean, seconds = 150) =>
  eventually(
    async () => {
      const reply = await send(url, 'GET', `/api/index/jobs/${job}`)
      return reply.status === 200 ? Schema.decodeUnknownSync(JobView)(reply.body) : undefined
    },
    (view) => view !== undefined && done(view),
    seconds,
  ).then((view) => {
    if (view === undefined) throw new Error(`The index never folded ${job}`)
    return view
  })
