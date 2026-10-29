import { Auth, Password, Schema as AuthSchema } from '@yielded/auth'
import { AuthPersistence } from '@yielded/auth-persistence-drizzle/D1'
import { Effect } from 'effect'
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { accounts } from '@sidequest/db'

import { AuthApi, requirement, sessionOptions } from './config.ts'
import * as EmailEntry from './EmailEntry.ts'

/** The server's auth installation. It lives here, not in `config.ts`, so the browser's contract
 * import never pulls in the strategies. */
export const makeAuth = () =>
  Auth.make(AuthApi, {
    sessions: sessionOptions,
    // `email` binds to the `sidequest/Auth/email` namespace: request binding, proofs, credentials.
    strategies: { password: Password.make(), email: EmailEntry.make() },
    defaultStrategy: 'password',
  })

export const AppAuth = makeAuth()
export const Persistence = AuthPersistence.make(AppAuth)

// Managed composition still owns subjects' identifiers, authority credentials, password verifiers,
// sessions and pending authentication. It provides nothing for email code sign-in or registration
// (P/internal/persistence.ts:158-168, :330-333), so EmailPersistence.ts maps those explicitly onto
// the managed identifiers/credentials tables plus the two tables declared below.
export const storage = Persistence.managed({
  subjects: {
    table: accounts,
    id: 'id',
    status: 'enabled',
    activeValue: true,
    securityRevision: 'securityRevision',
    idCodec: AuthSchema.SubjectId,
    requirements: () => Effect.succeed(requirement),
    actionRequirements: () => Effect.succeed(requirement),
  },
  prefix: 'sidequest_auth',
})

export const authSchema = storage.schema
// Drizzle Kit discovers table exports; keep the managed auth tables named and
// stable so the generated D1 migration owns the complete persistence boundary.
export const { identifiers, credentials, passwords, sessions, pending } = authSchema

/** One email sign-in credential per (module, address). Same shape as Yielded's managed
 * `emailCredentials` role (P/internal/storage-tables.ts:91-105). `credential_revision` always
 * equals the matching `sidequest_auth_credentials.revision`. */
export const emailCredentials = sqliteTable(
  'sidequest_auth_email_credentials',
  {
    moduleId: text('module_id').notNull(),
    subjectId: text('subject_id').notNull(),
    credentialId: text('credential_id').notNull(),
    identifierNamespace: text('identifier_namespace').notNull(),
    identifierValue: text('identifier_value').notNull(),
    credentialRevision: text('credential_revision').notNull(),
    active: integer('active', { mode: 'boolean' }).notNull(),
  },
  (table) => [
    uniqueIndex('sidequest_auth_email_credentials_credential').on(table.moduleId, table.credentialId),
    uniqueIndex('sidequest_auth_email_credentials_address').on(
      table.moduleId,
      table.identifierNamespace,
      table.identifierValue,
    ),
    index('sidequest_auth_email_credentials_subject').on(table.subjectId),
  ],
)

/** One current code per (module, purpose, address series). Same shape as Yielded's managed
 * `proofs` role (P/internal/storage-tables.ts:198-215); times are epoch milliseconds. */
export const proofs = sqliteTable(
  'sidequest_auth_proofs',
  {
    moduleId: text('module_id').notNull(),
    purpose: text('purpose').notNull(),
    seriesKey: text('series_key').notNull(),
    proofId: text('proof_id').notNull(),
    binding: text('binding').notNull(),
    verifierKeyId: text('verifier_key_id').notNull(),
    verifierDigest: text('verifier_digest').notNull(),
    issuedAt: integer('issued_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    failedAttempts: integer('failed_attempts').notNull(),
  },
  (table) => [
    uniqueIndex('sidequest_auth_proofs_series').on(table.moduleId, table.purpose, table.seriesKey),
    uniqueIndex('sidequest_auth_proofs_proof').on(table.moduleId, table.proofId),
    index('sidequest_auth_proofs_expiry').on(table.expiresAt),
  ],
)

export const authTables = {
  identifiers,
  credentials,
  passwords,
  sessions,
  pending,
  emailCredentials,
  proofs,
}
