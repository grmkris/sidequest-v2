import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

export const accounts = sqliteTable('accounts', {
  id: text('id').primaryKey(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  securityRevision: text('security_revision').notNull(),
  displayName: text('display_name').notNull(),
  // Yielded Auth inserts accounts through a synchronous mapping callback.
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
})

export const authAttemptBuckets = sqliteTable(
  'auth_attempt_buckets',
  {
    key: text('key').primaryKey().notNull(),
    tokens: real('tokens').notNull(),
    updatedAt: integer('updated_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
  },
  (table) => [index('auth_attempt_buckets_expiry').on(table.expiresAt)],
)

export const oauthClients = sqliteTable('oauth_clients', {
  clientId: text('client_id').primaryKey(),
  name: text('name').notNull(),
  redirectUris: text('redirect_uris', { mode: 'json' }).notNull().$type<ReadonlyArray<string>>(),
  applicationType: text('application_type', { enum: ['web', 'native'] }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
})

export const oauthGrants = sqliteTable(
  'oauth_grants',
  {
    namespace: text('namespace').notNull(),
    id: text('id').notNull(),
    version: text('version').notNull(),
    record: text('record').notNull(),
    subjectId: text('subject_id'),
    expiresAt: integer('expires_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.namespace, table.id] }),
    index('oauth_grants_subject').on(table.subjectId),
    index('oauth_grants_expiry').on(table.expiresAt),
  ],
)

export const oauthAssertions = sqliteTable(
  'oauth_assertions',
  {
    namespace: text('namespace').notNull(),
    receipt: text('receipt').notNull(),
    expiresAt: integer('expires_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.namespace, table.receipt] })],
)

export const walletLinks = sqliteTable(
  'wallet_links',
  {
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    namespace: text('namespace').notNull(),
    address: text('address').notNull(),
    chainId: integer('chain_id').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.namespace, table.address, table.chainId] }),
    uniqueIndex('wallet_links_account').on(table.accountId, table.namespace, table.address, table.chainId),
  ],
)
