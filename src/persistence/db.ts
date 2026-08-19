import Database from 'better-sqlite3';
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema/index.js';

export type AppDatabase = BetterSQLite3Database<typeof schema>;

export interface DatabaseConnection {
  sqlite: Database.Database;
  db: AppDatabase;
  close: () => void;
  checkpoint: (mode?: 'PASSIVE' | 'FULL' | 'RESTART' | 'TRUNCATE') => void;
}

export function createDatabaseConnection(dbPath = './smart_drive.db'): DatabaseConnection {
  const sqlite = new Database(dbPath);

  // Configure SQLite WAL mode and safety PRAGMAs
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('wal_autocheckpoint = 1000');

  const db = drizzle(sqlite, { schema });

  const checkpoint = (mode: 'PASSIVE' | 'FULL' | 'RESTART' | 'TRUNCATE' = 'PASSIVE') => {
    try {
      sqlite.pragma(`wal_checkpoint(${mode})`);
    } catch {
      // Best-effort checkpoint
    }
  };

  return {
    sqlite,
    db,
    close: () => {
      checkpoint('TRUNCATE');
      sqlite.close();
    },
    checkpoint,
  };
}

let defaultConnection: DatabaseConnection | null = null;

export function getDatabase(): DatabaseConnection {
  if (!defaultConnection) {
    const dbPath = process.env.DATABASE_URL || './smart_drive.db';
    defaultConnection = createDatabaseConnection(dbPath);
  }
  return defaultConnection;
}

export function closeDatabase(): void {
  if (defaultConnection) {
    defaultConnection.close();
    defaultConnection = null;
  }
}
