import { sqliteTable, integer, text, index } from 'drizzle-orm/sqlite-core';
import { files } from './files.js';
import { googleAccounts } from './google-accounts.js';

export const fileLocations = sqliteTable(
  'file_locations',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    fileId: integer('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    googleAccountId: integer('google_account_id')
      .notNull()
      .references(() => googleAccounts.id, { onDelete: 'restrict' }),
    providerFileId: text('provider_file_id').notNull(),
    status: text('status', {
      enum: ['ACTIVE', 'COPYING', 'VERIFIED', 'OLD', 'ORPHAN_CLEANUP'],
    })
      .notNull()
      .default('COPYING'),
    size: integer('size').notNull(),
    mimeType: text('mime_type').notNull().default('application/octet-stream'),
    checksum: text('checksum'),
    checksumType: text('checksum_type', {
      enum: ['MD5', 'SHA256', 'PROVIDER_HASH', 'NONE'],
    }),
    createdAt: integer('created_at').notNull(),
    migratedAt: integer('migrated_at'),
  },
  (table) => [
    index('idx_file_locations_file_id').on(table.fileId),
    index('idx_file_locations_google_account_id').on(table.googleAccountId),
    index('idx_file_locations_status').on(table.status),
    index('idx_file_locations_file_status').on(table.fileId, table.status),
  ]
);

export type FileLocationInsert = typeof fileLocations.$inferInsert;
export type FileLocationSelect = typeof fileLocations.$inferSelect;
