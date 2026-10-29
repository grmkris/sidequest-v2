import { Email, Identity, Proofs, Schema as AuthSchema, Sessions } from '@yielded/auth'
import { PersistenceMappingError } from '@yielded/auth-persistence'
import {
  emailRegistrationLayer,
  emailSignInTargetsLayer,
  proofPersistenceLayer,
  requiredEmailRegistrationConstraints,
  requiredEmailSignInConstraints,
  requiredProofConstraints,
} from '@yielded/auth-persistence-drizzle'
import * as D1 from '@yielded/auth-persistence-drizzle/D1'
import { sql, type SQL } from 'drizzle-orm'
import * as Drizzle from 'drizzle-orm/effect-d1'
import { Effect, Layer, Schema } from 'effect'
import * as Crypto from 'effect/Crypto'
import * as Base64Url from 'effect/encoding/Base64Url'
import * as Struct from 'effect/Struct'
import { accounts } from '@sidequest/db'

import { requirement } from './config.ts'
import type { EmailRegistration } from './EmailEntry.ts'
import { AppAuth, credentials, emailCredentials, identifiers, proofs } from './storage.ts'

/** Explicit D1 services for email code sign-in, email registration and proofs.
 * Requires: D1.Database, SqlClient, Crypto, LifecycleHooks. */

const mappingError = (operation: string) => (cause: unknown) => PersistenceMappingError.make({ operation, cause })
const encoder = new TextEncoder()

const subjectId = {
  toNative: (id: AuthSchema.SubjectId) => Effect.succeed<string>(id),
  toSubject: (native: string) =>
    Schema.decodeUnknownEffect(AuthSchema.SubjectId)(native).pipe(Effect.mapError(mappingError('decode'))),
  equals: (left: string, right: string) => left === right,
}

// Same engine clock as Yielded's managed SQLite storage (P/internal/storage-clock.ts:25-29); integer ms columns.
const clock = {
  encodeInstant: (millis: number) => millis,
  decodeInstant: (value: unknown) => Number(value),
  engineNowMillis: sql`cast(round((julianday('now') - 2440587.5) * 86400000) as integer)`,
  toMillis: (expression: SQL) => expression,
  fromMillis: (expression: SQL) => expression,
}

const subject = {
  table: accounts,
  id: 'id',
  status: 'enabled',
  securityRevision: 'securityRevision',
  isActiveStatus: (value: unknown) => value === true,
  activeStatusValue: true,
  // Email codes satisfy the `possession` alternative of the shared requirement (config.ts).
  decodeRequirement: () => Effect.succeed(requirement),
} as const

// Managed identifier/credential columns (P/internal/storage-tables.ts:57-75). The managed tables are
// typed as generic SQLiteTable, so rows are untyped records here.
const identifierRead = {
  table: identifiers,
  namespace: 'namespace',
  value: 'value',
  subjectId: 'subjectId',
  verifiedAt: 'verifiedAt',
  bindingRevision: 'revision',
  isCurrent: (row: Record<string, unknown>) => row.active === true && row.verifiedAt !== null,
} as const

const authorityCredential = {
  table: credentials,
  subjectId: 'subjectId',
  credentialId: 'credentialId',
  revision: 'revision',
  status: 'active',
  isActiveStatus: (value: unknown) => value === true,
  activeStatusValue: true,
  encodeInsert: (row: { readonly subjectId: string; readonly credentialId: string; readonly revision: string }) => ({
    ...row,
    active: true,
  }),
  encodeActivation: (revision: Sessions.SecurityRevision) => ({ revision, active: true }),
  encodeRetirement: (revision: Sessions.SecurityRevision) => ({ revision, active: false }),
} as const

const CredentialWithoutRequirement = Schema.Struct(Struct.omit(Email.EmailCredentialSnapshot.fields, ['requirement']))

const credentialRead = {
  table: emailCredentials,
  moduleId: 'moduleId',
  subjectId: 'subjectId',
  credentialId: 'credentialId',
  identifierNamespace: 'identifierNamespace',
  identifierValue: 'identifierValue',
  credentialRevision: 'credentialRevision',
  status: 'active',
  isActiveStatus: (value: unknown) => value === true,
  activeStatusValue: true,
  // Mirrors Yielded's managed decode (P/internal/storage-mapping.ts:333-355).
  decode: ({
    moduleId,
    subject: row,
    identifier,
    credential,
  }: {
    readonly moduleId: string
    readonly subject: typeof accounts.$inferSelect
    readonly identifier: Record<string, unknown>
    readonly credential: typeof emailCredentials.$inferSelect
  }) =>
    Schema.decodeUnknownEffect(CredentialWithoutRequirement)({
      moduleId,
      identifier: { namespace: identifier.namespace, value: identifier.value },
      identifierRevision: identifier.revision,
      verifiedAtMillis: identifier.verifiedAt,
      credentialId: credential.credentialId,
      credentialRevision: credential.credentialRevision,
      revision: {
        subjectId: row.id,
        securityRevision: row.securityRevision,
        credentials: [{ credentialId: credential.credentialId, revision: credential.credentialRevision }],
      },
    }).pipe(Effect.mapError(mappingError('decode'))),
} as const

const proofMapping = {
  proof: {
    table: proofs,
    moduleId: 'moduleId',
    purpose: 'purpose',
    seriesKey: 'seriesKey',
    proofId: 'proofId',
    binding: 'binding',
    verifierKeyId: 'verifierKeyId',
    verifierDigest: 'verifierDigest',
    issuedAt: 'issuedAt',
    expiresAt: 'expiresAt',
    failedAttempts: 'failedAttempts',
    // Every mapped column is overwritten by the store (P/internal/proof-native.ts:199-211); this
    // only satisfies the typed insert row.
    encodeInsert: ({
      record,
      seriesKey,
    }: {
      readonly record: typeof Proofs.ProofIssueRecord.Type
      readonly seriesKey: string
    }) => ({
      moduleId: record.moduleId,
      purpose: record.purpose,
      seriesKey,
      proofId: record.proofId,
      binding: '',
      verifierKeyId: record.verifier.keyId,
      verifierDigest: record.verifier.digest,
      issuedAt: 0,
      expiresAt: 0,
      failedAttempts: 0,
    }),
  },
  subject: { table: accounts, id: 'id' },
  subjectId,
  clock,
  constraints: requiredProofConstraints,
  d1: { primary: true },
} as const

const signInMapping = {
  subject,
  identifier: identifierRead,
  credential: credentialRead,
  authorityCredential,
  subjectId,
  constraints: requiredEmailSignInConstraints,
  decodeInstant: (native: unknown) =>
    Schema.decodeUnknownEffect(Schema.Int)(native).pipe(Effect.mapError(mappingError('decode'))),
} as const

/** Registration writes a verified identifier: unverified rows are never reassigned
 * (P/internal/email-registration-native.ts:193-244). */
const registrationIdentifier = {
  ...identifierRead,
  isMutableTarget: () => false,
  d1CurrentCondition: ({ bindingRevision }: { readonly bindingRevision: Sessions.SecurityRevision }) =>
    sql`${sql.identifier('active')} = 1 and ${sql.identifier('verified_at')} is not null and ${sql.identifier('revision')} = ${bindingRevision}`,
  encodeVerifiedInsert: (row: {
    readonly identifier: Identity.LoginIdentifier
    readonly subjectId: string
    readonly verifiedAtMillis: number
    readonly bindingRevision: Sessions.SecurityRevision
  }) => ({
    namespace: row.identifier.namespace,
    value: row.identifier.value,
    subjectId: row.subjectId,
    verifiedAt: row.verifiedAtMillis,
    revision: row.bindingRevision,
    active: true,
  }),
} as const

const registrationCredential = {
  ...credentialRead,
  encodeVerifiedInsert: (row: {
    readonly moduleId: string
    readonly subjectId: string
    readonly credentialId: string
    readonly identifier: Identity.LoginIdentifier
    readonly credentialRevision: Sessions.SecurityRevision
  }) => ({
    moduleId: row.moduleId,
    subjectId: row.subjectId,
    credentialId: row.credentialId,
    identifierNamespace: row.identifier.namespace,
    identifierValue: row.identifier.value,
    credentialRevision: row.credentialRevision,
    active: true,
  }),
} as const

/** Registration mapping; needs Crypto (allocation, fingerprint) and the D1 client (eligibility read). */
const makeRegistrationMapping = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto
  const drizzle = yield* Drizzle.makeWithDefaults({})
  const randomId = crypto.randomBytes(32).pipe(Effect.map(Base64Url.encode), Effect.mapError(mappingError('allocate')))

  // Never displace or adopt an existing address: any identifier row (verified, unverified,
  // disabled account, password-only account) makes the registration ineligible. The request then
  // returns an ordinary receipt and no mail is sent (Y/proofs/module.ts:339, :375).
  const inspect = (input: {
    readonly identifier: Identity.LoginIdentifier
    readonly registration: EmailRegistration
  }) =>
    Effect.gen(function* () {
      // The managed identifier table is typed generically, so its columns are named in SQL.
      const rows = yield* drizzle
        .select({ found: sql<number>`1` })
        .from(identifiers)
        .where(
          sql`${sql.identifier('namespace')} = ${input.identifier.namespace} and ${sql.identifier('value')} = ${input.identifier.value}`,
        )
        .limit(1)
      const bytes = yield* crypto.digest(
        'SHA-256',
        encoder.encode(
          JSON.stringify(['sidequest/email-registration/v1', input.identifier.value, input.registration.displayName]),
        ),
      )
      return { eligible: rows.length === 0, fingerprint: AuthSchema.TokenDigest.make(Base64Url.encode(bytes)) }
    }).pipe(Effect.mapError(mappingError('read')))

  return {
    mode: 'atomic',
    clock,
    d1: { primary: true },
    subject,
    identifier: registrationIdentifier,
    credential: registrationCredential,
    authorityCredential,
    subjectId,
    constraints: requiredEmailRegistrationConstraints,
    allocateCredentialId: randomId,
    allocateRevision: randomId.pipe(Effect.map((revision) => Sessions.SecurityRevision.make(revision))),
    isIdentifierConflict: () => false,
    isCredentialConflict: () => false,
    inspect,
    snapshotRegistration: (registration: EmailRegistration) =>
      Effect.succeed({ displayName: registration.displayName }),
    provisioning: {
      idMode: 'allocated',
      allocateSubjectId: randomId,
      // `accounts.created_at` needs `$defaultFn(() => new Date())` (see server.diff); this callback
      // is synchronous and cannot read Effect's Clock.
      encodeSubjectInsert: (
        intent: { readonly registration: EmailRegistration },
        values: { readonly nativeSubjectId: string | undefined; readonly securityRevision: Sessions.SecurityRevision },
      ) => ({
        // Defined for idMode 'allocated' (P/internal/email-registration-native.ts:277-286).
        id: values.nativeSubjectId ?? '',
        enabled: true,
        securityRevision: values.securityRevision,
        displayName: intent.registration.displayName,
      }),
    },
  } as const
})

/** EmailSignInTargets + ProofPersistence + the email strategy's RegistrationAuthority. */
export const emailPersistenceLayer = Layer.unwrap(
  Effect.gen(function* () {
    const registration = yield* makeRegistrationMapping
    return Layer.mergeAll(
      emailSignInTargetsLayer(D1.makeEmailSignInServices(signInMapping)),
      proofPersistenceLayer(D1.makeProofPersistenceServices(proofMapping)),
      emailRegistrationLayer(
        AppAuth.strategies.email.RegistrationAuthority,
        D1.makeEmailRegistrationServices(registration, proofMapping),
      ),
    )
  }),
)
