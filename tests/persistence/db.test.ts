import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabaseConnection, DatabaseConnection } from '../../src/persistence/db.js';
import { runMigrations } from '../../src/persistence/migrate.js';

describe('Database & Migration Setup', () => {
  let conn: DatabaseConnection;

  beforeEach(() => {
    conn = createDatabaseConnection(':memory:');
    runMigrations(conn);
  });

  afterEach(() => {
    conn.close();
  });

  it('enforces foreign key constraints', () => {
    const fkPragma = conn.sqlite.pragma('foreign_keys', { simple: true });
    expect(fkPragma).toBe(1);

    // Inserting a child file with a non-existent parent_id should fail
    expect(() => {
      conn.sqlite
        .prepare(
          `INSERT INTO files (name, parent_id, is_folder, mime_type, size, lifecycle_status, created_at, updated_at)
           VALUES ('orphan.txt', 9999, 0, 'text/plain', 100, 'ACTIVE', 1000, 1000)`
        )
        .run();
    }).toThrow();
  });

  it('creates all 6 core tables successfully', () => {
    const tables = conn.sqlite
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`
      )
      .all()
      .map((row: any) => row.name);

    expect(tables).toContain('files');
    expect(tables).toContain('google_accounts');
    expect(tables).toContain('file_locations');
    expect(tables).toContain('storage_operations');
    expect(tables).toContain('storage_reservations');
    expect(tables).toContain('file_migrations');
  });
});
