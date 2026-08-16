import { eq, and, gt, sql } from 'drizzle-orm';
import { AppDatabase } from '../../persistence/db.js';
import { googleAccounts } from '../../persistence/schema/google-accounts.js';
import { storageReservations } from '../../persistence/schema/storage-reservations.js';
import { StoragePlan } from '../planner/planner.types.js';
import { StorageReservation } from '../../domain/types.js';
import { ReservationConflictError, InsufficientCapacityError } from '../../domain/errors.js';

export class ReservationManager {
  private static readonly DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes

  constructor(private db: AppDatabase) {}

  /**
   * Atomically acquires all capacity reservations required by a StoragePlan.
   * If any drive lacks sufficient capacity (due to concurrent allocations),
   * the entire transaction rolls back cleanly with a ReservationConflictError.
   */
  acquirePlanReservations(
    plan: StoragePlan,
    operationId: string,
    ttlMs: number = ReservationManager.DEFAULT_TTL_MS
  ): StorageReservation[] {
    return this.db.transaction((tx) => {
      const now = Date.now();
      const acquired: StorageReservation[] = [];

      for (const req of plan.capacityReservations) {
        const account = tx
          .select()
          .from(googleAccounts)
          .where(eq(googleAccounts.id, req.driveId))
          .get();

        if (!account) {
          throw new InsufficientCapacityError(`Drive ID ${req.driveId} does not exist`);
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
              eq(storageReservations.googleAccountId, req.driveId),
              eq(storageReservations.status, 'ACTIVE'),
              gt(storageReservations.expiresAt, now)
            )
          )
          .get();

        const currentActiveReserved = activeRes?.totalReserved ?? 0;
        const currentUsable = Math.max(
          0,
          account.freeSpace - account.reservedBytes - currentActiveReserved
        );

        if (currentUsable < req.reservedBytes) {
          throw new ReservationConflictError(
            `Stale plan detected. Drive ${account.displayName} usable capacity (${currentUsable} B) cannot satisfy required ${req.reservedBytes} B.`,
            { driveId: req.driveId, currentUsable, requested: req.reservedBytes }
          );
        }

        const reservation = tx
          .insert(storageReservations)
          .values({
            googleAccountId: req.driveId,
            operationId,
            reservedBytes: req.reservedBytes,
            status: 'ACTIVE',
            expiresAt: now + ttlMs,
            createdAt: now,
          })
          .returning()
          .get();

        acquired.push(reservation);
      }

      return acquired;
    });
  }

  /**
   * Releases all active reservations associated with an operation (e.g. on rollback or cancellation).
   */
  releasePlanReservations(operationId: string): number {
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

  /**
   * Commits all active reservations associated with an operation (on successful execution).
   */
  commitPlanReservations(operationId: string): number {
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

  /**
   * Scans and expires stale/orphaned active reservations whose TTL has elapsed.
   */
  expireStaleReservations(currentTime: number = Date.now()): number {
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
}
