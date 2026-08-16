import { sqliteTable, integer, text, index } from 'drizzle-orm/sqlite-core';
import { files } from './files.js';
import { googleAccounts } from './google-accounts.js';
import { storageOperations } from './storage-operations.js';

export const fileMigrations = sqliteTable(
  'file_migrations',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    operationId: text('operation_id')
      .notNull()
      .references(() => storageOperations.id, { onDelete: 'cascade' }),
    fileId: integer('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    sourceDriveId: integer('source_drive_id')
      .notNull()
      .references(() => googleAccounts.id, { onDelete: 'restrict' }),
    sourceProviderFileId: text('source_provider_file_id').notNull(),
    destDriveId: integer('dest_drive_id')
      .notNull()
      .references(() => googleAccounts.id, { onDelete: 'restrict' }),
    destProviderFileId: text('dest_provider_file_id'),
    reason: text('reason', {
      enum: ['CAPACITY_REBALANCE', 'DRIVE_RETIREMENT', 'MANUAL_REQUEST'],
    }).notNull(),
    bytesTransferred: integer('bytes_transferred').notNull().default(0),
    status: text('status', {
      enum: ['IN_PROGRESS', 'VERIFIED', 'COMPLETED', 'FAILED', 'ABORTED'],
    })
      .notNull()
      .default('IN_PROGRESS'),
    startedAt: integer('started_at').notNull(),
    completedAt: integer('completed_at'),
  },
  (table) => [
    index('idx_migrations_file_id').on(table.fileId),
    index('idx_migrations_operation_id').on(table.operationId),
    index('idx_migrations_status').on(table.status),
  ]
);

export type FileMigrationInsert = typeof fileMigrations.$inferInsert;
export type FileMigrationSelect = typeof fileMigrations.$inferSelect;
