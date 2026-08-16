import { eq } from 'drizzle-orm';
import { AppDatabase } from '../db.js';
import { googleAccounts, GoogleAccountInsert, GoogleAccountSelect } from '../schema/google-accounts.js';
import { DriveStatus } from '../../domain/types.js';

export class GoogleAccountRepository {
  constructor(private db: AppDatabase) {}

  insert(data: GoogleAccountInsert): GoogleAccountSelect {
    return this.db.insert(googleAccounts).values(data).returning().get();
  }

  findById(id: number): GoogleAccountSelect | undefined {
    return this.db.select().from(googleAccounts).where(eq(googleAccounts.id, id)).get();
  }

  findByEmail(email: string): GoogleAccountSelect | undefined {
    return this.db.select().from(googleAccounts).where(eq(googleAccounts.email, email)).get();
  }

  listAll(): GoogleAccountSelect[] {
    return this.db.select().from(googleAccounts).all();
  }

  listAvailable(): GoogleAccountSelect[] {
    return this.db.select().from(googleAccounts).where(eq(googleAccounts.status, 'AVAILABLE')).all();
  }

  updateCapacity(id: number, totalSpace: number, usedSpace: number): GoogleAccountSelect | undefined {
    const freeSpace = Math.max(0, totalSpace - usedSpace);
    const now = Date.now();
    return this.db
      .update(googleAccounts)
      .set({
        totalSpace,
        usedSpace,
        freeSpace,
        lastSyncedAt: now,
        updatedAt: now,
      })
      .where(eq(googleAccounts.id, id))
      .returning()
      .get();
  }

  updateStatus(id: number, status: DriveStatus): GoogleAccountSelect | undefined {
    return this.db
      .update(googleAccounts)
      .set({ status, updatedAt: Date.now() })
      .where(eq(googleAccounts.id, id))
      .returning()
      .get();
  }

  recordFailure(id: number, newStatus: DriveStatus, failures: number): GoogleAccountSelect | undefined {
    return this.db
      .update(googleAccounts)
      .set({
        status: newStatus,
        consecutiveFailures: failures,
        updatedAt: Date.now(),
      })
      .where(eq(googleAccounts.id, id))
      .returning()
      .get();
  }

  recordSuccess(id: number): GoogleAccountSelect | undefined {
    return this.db
      .update(googleAccounts)
      .set({
        status: 'AVAILABLE',
        consecutiveFailures: 0,
        updatedAt: Date.now(),
      })
      .where(eq(googleAccounts.id, id))
      .returning()
      .get();
  }

  setMigrationLock(id: number, locked: boolean): GoogleAccountSelect | undefined {
    return this.db
      .update(googleAccounts)
      .set({ migrationLocked: locked, updatedAt: Date.now() })
      .where(eq(googleAccounts.id, id))
      .returning()
      .get();
  }

  setReservedBytes(id: number, reservedBytes: number): GoogleAccountSelect | undefined {
    return this.db
      .update(googleAccounts)
      .set({ reservedBytes, updatedAt: Date.now() })
      .where(eq(googleAccounts.id, id))
      .returning()
      .get();
  }

  updateCredentials(id: number, encryptedCredentials: string): GoogleAccountSelect | undefined {
    return this.db
      .update(googleAccounts)
      .set({ encryptedCredentials, updatedAt: Date.now() })
      .where(eq(googleAccounts.id, id))
      .returning()
      .get();
  }

  delete(id: number): boolean {
    const result = this.db.delete(googleAccounts).where(eq(googleAccounts.id, id)).run();
    return result.changes > 0;
  }
}
