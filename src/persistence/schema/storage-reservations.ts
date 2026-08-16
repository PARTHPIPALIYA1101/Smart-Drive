import { sqliteTable, integer, text, index } from 'drizzle-orm/sqlite-core';
import { googleAccounts } from './google-accounts.js';
import { storageOperations } from './storage-operations.js';

export const storageReservations = sqliteTable(
  'storage_reservations',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    googleAccountId: integer('google_account_id')
      .notNull()
      .references(() => googleAccounts.id, { onDelete: 'cascade' }),
    operationId: text('operation_id')
      .notNull()
      .references(() => storageOperations.id, { onDelete: 'cascade' }),
    reservedBytes: integer('reserved_bytes').notNull(),
    status: text('status', {
      enum: ['ACTIVE', 'COMMITTED', 'RELEASED', 'EXPIRED'],
    })
      .notNull()
      .default('ACTIVE'),
    expiresAt: integer('expires_at').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('idx_reservations_account_status').on(table.googleAccountId, table.status),
    index('idx_reservations_operation_id').on(table.operationId),
    index('idx_reservations_expires_at').on(table.expiresAt),
  ]
);

export type StorageReservationInsert = typeof storageReservations.$inferInsert;
export type StorageReservationSelect = typeof storageReservations.$inferSelect;
