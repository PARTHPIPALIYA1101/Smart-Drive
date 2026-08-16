import { sqliteTable, integer, text, index } from 'drizzle-orm/sqlite-core';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';

export const files = sqliteTable(
  'files',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    parentId: integer('parent_id').references((): AnySQLiteColumn => files.id, {
      onDelete: 'restrict',
    }),
    isFolder: integer('is_folder', { mode: 'boolean' }).notNull().default(false),
    mimeType: text('mime_type').notNull().default('application/octet-stream'),
    size: integer('size').notNull().default(0),
    lifecycleStatus: text('lifecycle_status', {
      enum: ['PENDING', 'ACTIVE', 'TRASHED', 'FAILED'],
    })
      .notNull()
      .default('PENDING'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    lastAccessedAt: integer('last_accessed_at'),
    lastDownloadedAt: integer('last_downloaded_at'),
    trashedAt: integer('trashed_at'),
  },
  (table) => [
    index('idx_files_parent_id').on(table.parentId),
    index('idx_files_lifecycle_status').on(table.lifecycleStatus),
    index('idx_files_name').on(table.name),
  ]
);

export type FileInsert = typeof files.$inferInsert;
export type FileSelect = typeof files.$inferSelect;
