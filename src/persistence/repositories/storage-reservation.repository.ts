import { eq, and, gt, sql } from 'drizzle-orm';
import { AppDatabase } from '../db.js';
import { storageReservations, StorageReservationInsert, StorageReservationSelect } from '../schema/storage-reservations.js';
import { googleAccounts } from '../schema/google-accounts.js';
import { ReservationStatus } from '../../domain/types.js';
import { InsufficientCapacityError, ReservationConflictError } from '../../domain/errors.js';

export class StorageReservationRepository {
  constructor(private db: AppDatabase) {}

  insert(data: StorageReservationInsert): StorageReservationSelect {
    return this.db.insert(storageReservations).values(data).returning().get();
  }

  findById(id: number): StorageReservationSelect | undefined {
    return this.db.select().from(storageReservations).where(eq(storageReservations.id, id)).get();
  }

  findActiveByAccount(googleAccountId: number): StorageReservationSelect[] {
    const now = Date.now();
    return this.db
      .select()
      .from(storageReservations)
      .where(
        and(
          eq(storageReservations.googleAccountId, googleAccountId),
          eq(storageReservations.status, 'ACTIVE'),
          gt(storageReservations.expiresAt, now)
        )
      )
      .all();
  }

  findActiveByOperation(operationId: string): StorageReservationSelect[] {
    return this.db
      .select()
      .from(storageReservations)
      .where(
        and(
          eq(storageReservations.operationId, operationId),
          eq(storageReservations.status, 'ACTIVE')
        )
      )
      .all();
  }

  calculateActiveReservedBytes(googleAccountId: number): number {
    const now = Date.now();
    const result = this.db
      .select({
        totalReserved: sql<number>`COALESCE(SUM(${storageReservations.reservedBytes}), 0)`,
      })
      .from(storageReservations)
      .where(
        and(
          eq(storageReservations.googleAccountId, googleAccountId),
          eq(storageReservations.status, 'ACTIVE'),
          gt(storageReservations.expiresAt, now)
        )
      )
      .get();

    return result?.totalReserved ?? 0;
  }

  updateStatus(id: number, status: ReservationStatus): StorageReservationSelect | undefined {
    return this.db
      .update(storageReservations)
      .set({ status })
      .where(eq(storageReservations.id, id))
      .returning()
      .get();
  }

  releaseByOperationId(operationId: string): number {
    const result = this.db
      .update(storageReservations)
      .set({ status: 'RELEASED' })
      .where(
        and(
          eq(storageReservations.operationId, operationId),
          eq(storageReservations.status, 'ACTIVE')
        )
      )
      .run();

    return result.changes;
  }

  commitByOperationId(operationId: string): number {
    const result = this.db
      .update(storageReservations)
      .set({ status: 'COMMITTED' })
      .where(
        and(
          eq(storageReservations.operationId, operationId),
          eq(storageReservations.status, 'ACTIVE')
        )
      )
      .run();

    return result.changes;
  }

  expireOldReservations(currentTime = Date.now()): number {
    const result = this.db
      .update(storageReservations)
      .set({ status: 'EXPIRED' })
      .where(
        and(
          eq(storageReservations.status, 'ACTIVE'),
          sql`${storageReservations.expiresAt} <= ${currentTime}`
        )
      )
      .run();

    return result.changes;
  }

  /**
   * Atomically acquires capacity reservation on a Drive inside a database transaction.
   * Computes Usable Capacity = freeSpace - reservedBytes - active_reservations.
   * Rejects with InsufficientCapacityError if capacity is insufficient.
   */
  acquireAtomic(
    googleAccountId: number,
    operationId: string,
    requestedBytes: number,
    ttlMs = 600000
  ): StorageReservationSelect {
    return this.db.transaction((tx) => {
      const now = Date.now();

      const account = tx
        .select()
        .from(googleAccounts)
        .where(eq(googleAccounts.id, googleAccountId))
        .get();

      if (!account) {
        throw new InsufficientCapacityError(`Drive ${googleAccountId} does not exist`);
      }

      if (account.status !== 'AVAILABLE' && account.status !== 'DEGRADED') {
        throw new InsufficientCapacityError(
          `Drive ${account.displayName} (${account.email}) is ${account.status}`
        );
      }

      const activeRes = tx
        .select({
          totalReserved: sql<number>`COALESCE(SUM(${storageReservations.reservedBytes}), 0)`,
        })
        .from(storageReservations)
        .where(
          and(
            eq(storageReservations.googleAccountId, googleAccountId),
            eq(storageReservations.status, 'ACTIVE'),
            gt(storageReservations.expiresAt, now)
          )
        )
        .get();

      const currentActiveReserved = activeRes?.totalReserved ?? 0;
      const usableCapacity = Math.max(
        0,
        account.freeSpace - account.reservedBytes - currentActiveReserved
      );

      if (usableCapacity < requestedBytes) {
        throw new ReservationConflictError(
          `Insufficient usable capacity on Drive ${account.displayName}. Needed: ${requestedBytes} bytes, Usable: ${usableCapacity} bytes.`
        );
      }

      const reservation = tx
        .insert(storageReservations)
        .values({
          googleAccountId,
          operationId,
          reservedBytes: requestedBytes,
          status: 'ACTIVE',
          expiresAt: now + ttlMs,
          createdAt: now,
        })
        .returning()
        .get();

      return reservation;
    });
  }
}
