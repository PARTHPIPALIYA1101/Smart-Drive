import { sqliteTable, integer, text, index } from 'drizzle-orm/sqlite-core';

export const googleAccounts = sqliteTable(
  'google_accounts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    email: text('email').notNull().unique(),
    displayName: text('display_name').notNull(),
    totalSpace: integer('total_space').notNull().default(0),
    usedSpace: integer('used_space').notNull().default(0),
    freeSpace: integer('free_space').notNull().default(0),
    reservedBytes: integer('reserved_bytes').notNull().default(0),
    migrationLocked: integer('migration_locked', { mode: 'boolean' }).notNull().default(false),
    status: text('status', {
      enum: ['AVAILABLE', 'DEGRADED', 'UNAVAILABLE', 'DISCONNECTED'],
    })
      .notNull()
      .default('AVAILABLE'),
    encryptedCredentials: text('encrypted_credentials').notNull(),
    lastSyncedAt: integer('last_synced_at'),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    index('idx_google_accounts_status').on(table.status),
    index('idx_google_accounts_email').on(table.email),
  ]
);

export type GoogleAccountInsert = typeof googleAccounts.$inferInsert;
export type GoogleAccountSelect = typeof googleAccounts.$inferSelect;
