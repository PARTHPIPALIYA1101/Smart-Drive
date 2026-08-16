import { DatabaseConnection } from './db.js';
import * as fs from 'fs';
import * as path from 'path';

export function runMigrations(conn: DatabaseConnection): void {
  // Execute database PRAGMAs
  conn.sqlite.pragma('journal_mode = WAL');
  conn.sqlite.pragma('foreign_keys = ON');
  conn.sqlite.pragma('busy_timeout = 5000');
  conn.sqlite.pragma('synchronous = NORMAL');

  // Create internal migration tracking table
  conn.sqlite.exec(`
    CREATE TABLE IF NOT EXISTS _smart_drive_migrations (
      id TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);

  const migrationFile = '0000_last_warbound.sql';
  const applied = conn.sqlite
    .prepare('SELECT id FROM _smart_drive_migrations WHERE id = ?')
    .get(migrationFile);

  if (applied) {
    return; // Migration already applied
  }

  // Read and apply migration SQL files
  const migrationPath = path.resolve(process.cwd(), 'drizzle', migrationFile);
  if (fs.existsSync(migrationPath)) {
    const rawSql = fs.readFileSync(migrationPath, 'utf-8');
    
    // Normalize to IF NOT EXISTS for idempotency
    const safeSql = rawSql
      .replace(/CREATE TABLE /g, 'CREATE TABLE IF NOT EXISTS ')
      .replace(/CREATE INDEX /g, 'CREATE INDEX IF NOT EXISTS ')
      .replace(/CREATE UNIQUE INDEX /g, 'CREATE UNIQUE INDEX IF NOT EXISTS ');

    const statements = safeSql
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    conn.sqlite.transaction(() => {
      for (const statement of statements) {
        conn.sqlite.exec(statement);
      }
      conn.sqlite
        .prepare('INSERT OR IGNORE INTO _smart_drive_migrations (id, applied_at) VALUES (?, ?)')
        .run(migrationFile, Date.now());
    })();
  } else {
    throw new Error(`Migration file not found at ${migrationPath}`);
  }
}
