import { Database } from 'bun:sqlite'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { Schema } from 'effect'
import { isAddressEqual, isHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { RelayerAccount } from './Evidence.ts'
import type { World } from './Hire.ts'

// After the cases: the relayer has nothing left in flight. On chain, its pending nonce equals its mined one (no
// transaction queued behind a gap), and every transaction it handed the node was either mined or replaced at its
// nonce. In the stack's local D1 (Alchemy's dev state under `.alchemy/local/d1`), every intent is mined or released,
// or still open with a transaction the chain has mined (the store closes an intent at the relayer's next look).

const d1 = new URL('../../../.alchemy/local/d1/cloudflare-runtime-D1DatabaseObject/', import.meta.url)

/** When a file under the D1 directory last changed (SQLite writes its WAL first), or 0 if it is not there. */
const modifiedAt = (name: string) => {
  const file = new URL(name, d1)
  return existsSync(file) ? statSync(file).mtimeMs : 0
}

const Row = Schema.Struct({ id: Schema.String, state: Schema.String, hashes: Schema.NullOr(Schema.String) })

/**
 * The relayer's intents in the local D1 that holds them, if one does: the newest such database, since a destroyed
 * stage leaves its file behind and Arc testnet runs reuse one relayer key, so earlier runs' databases hold it too.
 */
const storedIntents = (signer: string) => {
  if (!existsSync(d1)) return undefined
  const files = readdirSync(d1)
    .filter((name) => name.endsWith('.sqlite') && name !== 'metadata.sqlite')
    .map((name) => ({ name, modified: Math.max(...[name, `${name}-wal`].map(modifiedAt)) }))
    .toSorted((a, b) => b.modified - a.modified)
  for (const { name: file } of files) {
    const database = new Database(new URL(file, d1).pathname, { readonly: true })
    try {
      const table = database.query("SELECT name FROM sqlite_master WHERE name = 'relayer_transactions'").all()
      if (table.length === 0) continue
      const rows = database
        .query(
          `SELECT i.id, i.state, GROUP_CONCAT(t.hash) AS hashes FROM relayer_intents i
           LEFT JOIN relayer_transactions t ON t.intent = i.id AND t.nonce = i.nonce
           WHERE i.signer = ? GROUP BY i.id`,
        )
        .all(signer)
        .map((row) => Schema.decodeUnknownSync(Row)(row))
      if (rows.length > 0) return rows
    } finally {
      database.close()
    }
  }
  return undefined
}

/** Whether the chain mined one of `hashes`. */
const anyMined = async (world: Pick<World, 'chain'>, hashes: string | null) => {
  for (const hash of (hashes ?? '').split(',').filter((each) => isHex(each))) {
    const receipt = await world.chain.client.getTransactionReceipt({ hash }).catch(() => undefined)
    if (receipt !== undefined) return true
  }
  return false
}

/** The relayer's account of its nonces; fails if anything it sent is still unsettled. */
export const relayerSettled = async (world: Pick<World, 'chain' | 'proxy'>): Promise<RelayerAccount> => {
  const address = privateKeyToAccount(world.chain.keys.relayer).address
  const client = world.chain.client
  const latestNonce = await client.getTransactionCount({ address, blockTag: 'latest' })
  const pendingNonce = await client.getTransactionCount({ address, blockTag: 'pending' })
  if (pendingNonce !== latestNonce)
    throw new Error(`The relayer has ${pendingNonce - latestNonce} transactions waiting`)
  const sent = world.proxy.sent
  const releases = sent.filter((one) => isHex(one.to) && isAddressEqual(one.to, address))
  const stored = storedIntents(address)
  const counts: Record<string, number> = {}
  for (const row of stored ?? []) {
    const state = row.state === 'open' && (await anyMined(world, row.hashes)) ? 'open, mined on chain' : row.state
    counts[state] = (counts[state] ?? 0) + 1
  }
  const unsettled = Object.entries(counts).filter(([state]) => state === 'open')
  if (unsettled.length > 0) throw new Error(`Relayer intents left unsettled: ${JSON.stringify(counts)}`)
  return {
    address,
    transactions: sent.length,
    calls: sent.length - releases.length,
    releases: releases.length,
    withheld: sent.filter((one) => one.withheld).length,
    latestNonce,
    pendingNonce,
    intents: stored === undefined ? 'not inspected (no local D1 found)' : counts,
    sent: sent.map(({ hash, nonce, withheld, at, ...call }) => ({
      hash,
      nonce,
      function: call.function,
      withheld,
      at,
    })),
  }
}
