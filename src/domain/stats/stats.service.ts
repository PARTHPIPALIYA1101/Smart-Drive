import { FileRepository } from '../../persistence/repositories/file.repository.js';
import { GoogleAccountRepository } from '../../persistence/repositories/google-account.repository.js';
import { FileLocationRepository } from '../../persistence/repositories/file-location.repository.js';
import { StorageOperationRepository } from '../../persistence/repositories/storage-operation.repository.js';
import { FileMigrationRepository } from '../../persistence/repositories/file-migration.repository.js';
import { CapacityService } from '../capacity/capacity.service.js';
import { StorageStatisticsReport, DriveStorageStats } from './stats.types.js';
import { eq, and, sql } from 'drizzle-orm';
import { AppDatabase } from '../../persistence/db.js';
import { storageOperations } from '../../persistence/schema/storage-operations.js';
import { fileMigrations } from '../../persistence/schema/file-migrations.js';
import { fileLocations } from '../../persistence/schema/file-locations.js';

export class StorageStatsService {
  constructor(
    private db: AppDatabase,
    private fileRepo: FileRepository,
    private accountRepo: GoogleAccountRepository,
    private locationRepo: FileLocationRepository,
    private operationRepo: StorageOperationRepository,
    private migrationRepo: FileMigrationRepository,
    private capacityService: CapacityService
  ) {}

  /**
   * Computes a full unified statistics report distinguishing logical vs physical storage.
   */
  getStatistics(): StorageStatisticsReport {
    // 1. Logical file & folder counts & size
    const totalLogicalBytes = this.fileRepo.sumActiveLogicalBytes();
    const totalFiles = this.fileRepo.countActive(false);
    const totalFolders = this.fileRepo.countActive(true);
    const totalTrashItems = this.fileRepo.countTrashed();

    // 2. Capacity & Provider state
    const capacityReport = this.capacityService.getUnifiedCapacityReport();

    // 3. Operation transfer metrics from journal
    const uploadStats = this.db
      .select({
        totalBytes: sql<number>`COALESCE(SUM(${storageOperations.requestedBytes}), 0)`,
      })
      .from(storageOperations)
      .where(
        and(
          eq(storageOperations.operationType, 'UPLOAD'),
          eq(storageOperations.status, 'COMPLETED')
        )
      )
      .get();

    const downloadStats = this.db
      .select({
        totalBytes: sql<number>`COALESCE(SUM(${storageOperations.requestedBytes}), 0)`,
      })
      .from(storageOperations)
      .where(
        and(
          eq(storageOperations.operationType, 'DOWNLOAD'),
          eq(storageOperations.status, 'COMPLETED')
        )
      )
      .get();

    const migrationStats = this.db
      .select({
        totalBytes: sql<number>`COALESCE(SUM(${fileMigrations.bytesTransferred}), 0)`,
      })
      .from(fileMigrations)
      .where(eq(fileMigrations.status, 'COMPLETED'))
      .get();

    // 4. Per-Drive Statistics
    const driveStats: DriveStorageStats[] = capacityReport.drives.map((snap) => {
      const activeFilesCount = this.db
        .select({ count: sql<number>`count(*)` })
        .from(fileLocations)
        .where(
          and(
            eq(fileLocations.googleAccountId, snap.accountId),
            eq(fileLocations.status, 'ACTIVE')
          )
        )
        .get();

      const failedOps = this.db
        .select({ count: sql<number>`count(*)` })
        .from(storageOperations)
        .where(
          and(
            eq(storageOperations.status, 'FAILED'),
            sql`(${storageOperations.sourceDriveId} = ${snap.accountId} OR ${storageOperations.destDriveId} = ${snap.accountId})`
          )
        )
        .get();

      return {
        accountId: snap.accountId,
        displayName: snap.displayName,
        email: snap.email,
        status: snap.status,
        migrationLocked: snap.migrationLocked,
        totalCapacity: snap.totalSpace,
        usedCapacity: snap.usedSpace,
        freeCapacity: snap.freeSpace,
        reservedCapacity: snap.reservedBytes + snap.activeReservations,
        usableCapacity: snap.usableSpace,
        fileCount: activeFilesCount?.count ?? 0,
        failedOperationsCount: failedOps?.count ?? 0,
        lastSyncedAt: snap.lastSyncedAt,
      };
    });

    return {
      totalLogicalBytes,
      totalFiles,
      totalFolders,
      totalTrashItems,
      totalPhysicalBytes: capacityReport.totalUsedBytes,
      totalCapacityBytes: capacityReport.totalUnifiedBytes,
      totalFreeBytes: capacityReport.totalFreeBytes,
      totalUsableBytes: capacityReport.totalUsableBytes,
      totalUploadedBytes: uploadStats?.totalBytes ?? 0,
      totalDownloadedBytes: downloadStats?.totalBytes ?? 0,
      totalMigratedBytes: migrationStats?.totalBytes ?? 0,
      drives: driveStats,
    };
  }
}
