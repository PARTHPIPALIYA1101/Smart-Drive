import { GoogleAccountRepository } from '../../persistence/repositories/google-account.repository.js';
import { StorageReservationRepository } from '../../persistence/repositories/storage-reservation.repository.js';
import { DriveCapacitySnapshot, UnifiedCapacityReport } from './capacity.types.js';
import { EntityNotFoundError } from '../errors.js';
import { GoogleAccount } from '../types.js';

export class CapacityService {
  constructor(
    private accountRepo: GoogleAccountRepository,
    private reservationRepo: StorageReservationRepository
  ) {}

  /**
   * Computes the usable capacity snapshot for a single Google Drive account.
   */
  getDriveCapacitySnapshot(accountId: number): DriveCapacitySnapshot {
    const account = this.accountRepo.findById(accountId);
    if (!account) {
      throw new EntityNotFoundError('Google Account', accountId);
    }

    return this.buildSnapshot(account);
  }

  /**
   * Generates a comprehensive unified capacity report across all connected Google Drive accounts.
   */
  getUnifiedCapacityReport(): UnifiedCapacityReport {
    const accounts = this.accountRepo.listAll();
    const snapshots: DriveCapacitySnapshot[] = accounts.map((acc) => this.buildSnapshot(acc));

    let totalUnifiedBytes = 0;
    let totalUsedBytes = 0;
    let totalFreeBytes = 0;
    let totalUsableBytes = 0;
    let largestSingleFileCapacity = 0;

    let availableCount = 0;
    let degradedCount = 0;
    let unavailableCount = 0;
    let lockedCount = 0;

    for (const snap of snapshots) {
      if (snap.status === 'AVAILABLE') availableCount++;
      else if (snap.status === 'DEGRADED') degradedCount++;
      else unavailableCount++;

      if (snap.migrationLocked) lockedCount++;

      totalUnifiedBytes += snap.totalSpace;
      totalUsedBytes += snap.usedSpace;
      totalFreeBytes += snap.freeSpace;

      // Only healthy drives contribute to usable capacity
      if (snap.status === 'AVAILABLE' || snap.status === 'DEGRADED') {
        totalUsableBytes += snap.usableSpace;
        if (snap.usableSpace > largestSingleFileCapacity) {
          largestSingleFileCapacity = snap.usableSpace;
        }
      }
    }

    return {
      totalUnifiedBytes,
      totalUsedBytes,
      totalFreeBytes,
      totalUsableBytes,
      largestSingleFileCapacity,
      connectedDrivesCount: accounts.length,
      availableDrivesCount: availableCount,
      degradedDrivesCount: degradedCount,
      unavailableDrivesCount: unavailableCount,
      migrationLockedDrivesCount: lockedCount,
      drives: snapshots,
    };
  }

  private buildSnapshot(account: GoogleAccount): DriveCapacitySnapshot {
    const activeReservedBytes = this.reservationRepo.calculateActiveReservedBytes(account.id);

    let usableSpace = 0;
    if (account.status === 'AVAILABLE' || account.status === 'DEGRADED') {
      usableSpace = Math.max(0, account.freeSpace - account.reservedBytes - activeReservedBytes);
    }

    return {
      accountId: account.id,
      email: account.email,
      displayName: account.displayName,
      status: account.status,
      totalSpace: account.totalSpace,
      usedSpace: account.usedSpace,
      freeSpace: account.freeSpace,
      reservedBytes: account.reservedBytes,
      activeReservations: activeReservedBytes,
      usableSpace,
      migrationLocked: account.migrationLocked,
      lastSyncedAt: account.lastSyncedAt,
    };
  }
}
