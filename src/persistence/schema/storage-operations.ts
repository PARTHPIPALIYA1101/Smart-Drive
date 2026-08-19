import { sqliteTable, integer, text, index } from 'drizzle-orm/sqlite-core';
import { files } from './files.js';
import { googleAccounts } from './google-accounts.js';

export const storageOperations = sqliteTable(
  'storage_operations',
  {
    id: text('id').primaryKey(),
    operationType: text('operation_type', {
      enum: [
        'UPLOAD',
        'DOWNLOAD',
        'COPY',
        'VIRTUAL_MOVE',
        'PHYSICAL_MIGRATE',
        'DELETE_TRASH',
        'PERMANENT_DELETE',
        'RESTORE',
        'DRIVE_RETIRE',
      ],
    }).notNull(),
    fileId: integer('file_id').references(() => files.id, { onDelete: 'set null' }),
    sourceDriveId: integer('source_drive_id').references(() => googleAccounts.id, {
      onDelete: 'set null',
    }),
    destDriveId: integer('dest_drive_id').references(() => googleAccounts.id, {
      onDelete: 'set null',
    }),
    requestedBytes: integer('requested_bytes').notNull().default(0),
    status: text('status', {
      enum: [
        'PENDING',
        'RESERVED',
        'EXECUTING',
        'WAITING_FOR_SOURCE',
        'VERIFYING',
        'SWITCHING',
        'COMPLETED',
        'FAILED',
        'CANCELLED',
        'RECOVERY_REQUIRED',
      ],
    })
      .notNull()
      .default('PENDING'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    planContext: text('plan_context'),
    createdAt: integer('created_at').notNull(),
    startedAt: integer('started_at'),
    completedAt: integer('completed_at'),
  },
  (table) => [
    index('idx_storage_operations_status').on(table.status),
    index('idx_storage_operations_type').on(table.operationType),
    index('idx_storage_operations_file_id').on(table.fileId),
  ]
);

export type StorageOperationInsert = typeof storageOperations.$inferInsert;
export type StorageOperationSelect = typeof storageOperations.$inferSelect;
