import { it } from '@effect/vitest'
import { Schema } from 'effect'
import { describe, expect, test } from 'vitest'
import { AccountRef } from '../src/AccountRef.ts'
import { Amount } from '../src/Amount.ts'
import { AssetId, AssetRef } from '../src/AssetRef.ts'
import { UsdcOnArcTestnet } from '../src/AssetRegistry.ts'
import { Digest } from '../src/Digest.ts'
import { ConnectionId, ConnectRequestId } from '../src/Id.ts'
import { NetworkRef } from '../src/NetworkRef.ts'
import { Terms } from '../src/Terms.ts'
import { encodedTerms } from './fixtures.ts'

// Generated objects may lack Object.prototype, so compare by the schema's own equivalence.
const roundTrips = <S extends Schema.Codec<unknown, unknown>>(schema: S, value: S['Type']) =>
  Schema.toEquivalence(schema)(Schema.decodeUnknownSync(schema)(Schema.encodeSync(schema)(value)), value)

const generated = { AccountRef, Amount, AssetId, ConnectionId, ConnectRequestId, Digest, NetworkRef }

describe('every record survives encode then decode', () => {
  for (const [name, schema] of Object.entries(generated)) {
    it.prop(name, [schema], ([value]) => roundTrips(schema, value))
  }

  // These carry cross-field rules a random value almost never meets, so they use known-good values.
  test.each([
    ['Terms', Terms, encodedTerms],
    ['AssetRef', AssetRef, Schema.encodeSync(AssetRef)(UsdcOnArcTestnet)],
  ] as const)('%s', (_name, schema, encoded) => {
    expect(Schema.encodeSync(schema)(Schema.decodeUnknownSync(schema)(encoded))).toStrictEqual(encoded)
  })
})
