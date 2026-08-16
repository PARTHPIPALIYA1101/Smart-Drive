import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabaseConnection, DatabaseConnection } from '../../src/persistence/db.js';
import { runMigrations } from '../../src/persistence/migrate.js';
import {
  FileRepository,
  GoogleAccountRepository,
  FileLocationRepository,
  StorageOperationRepository,
  StorageReservationRepository,
  FileMigrationRepository,
} from '../../src/persistence/repositories/index.js';
import { CapacityService } from '../../src/domain/capacity/capacity.service.js';
import { StorageStatsService } from '../../src/domain/stats/stats.service.js';

describe('StorageStatsService Suite', () => {
  let conn: DatabaseConnection;
  let fileRepo: FileRepository;
  let locationRepo: FileLocationRepository;
  let accountRepo: GoogleAccountRepository;
  let opRepo: StorageOperationRepository;
  let resRepo: StorageReservationRepository;
  let migRepo: FileMigrationRepository;
  let capacityService: CapacityService;
  let statsService: StorageStatsService;

  beforeEach(() => {
    conn = createDatabaseConnection(':memory:');
    runMigrations(conn);

    fileRepo = new FileRepository(conn.db);
    locationRepo = new FileLocationRepository(conn.db);
    accountRepo = new GoogleAccountRepository(conn.db);
    opRepo = new StorageOperationRepository(conn.db);
    resRepo = new StorageReservationRepository(conn.db);
    migRepo = new FileMigrationRepository(conn.db);
    capacityService = new CapacityService(accountRepo, resRepo);

    statsService = new StorageStatsService(
      conn.db,
      fileRepo,
      accountRepo,
      locationRepo,
      opRepo,
      migRepo,
      capacityService
    );
  });

  afterEach(() => {
    conn.close();
  });

  it('correctly distinguishes logical storage vs physical transfer metrics', () => {
    const now = Date.now();

    // Drive A & B
    const driveA = accountRepo.insert({
      email: 'a@gmail.com',
      displayName: 'Drive A',
      totalSpace: 20000,
      usedSpace: 5000,
      freeSpace: 15000,
      reservedBytes: 0,
      migrationLocked: false,
      status: 'AVAILABLE',
      encryptedCredentials: 'enc',
      createdAt: now,
      updatedAt: now,
    });

    const driveB = accountRepo.insert({
      email: 'b@gmail.com',
      displayName: 'Drive B',
      totalSpace: 30000,
      usedSpace: 10000,
      freeSpace: 20000,
      reservedBytes: 0,
      migrationLocked: false,
      status: 'AVAILABLE',
      encryptedCredentials: 'enc',
      createdAt: now,
      updatedAt: now,
    });

    // 1 Folder, 2 Active Files, 1 Trashed File
    const folder = fileRepo.insert({
      name: 'Docs',
      parentId: null,
      isFolder: true,
      mimeType: 'application/x-directory',
      size: 0,
      lifecycleStatus: 'ACTIVE',
      createdAt: now,
      updatedAt: now,
    });

    const file1 = fileRepo.insert({
      name: 'f1.bin',
      parentId: folder.id,
      isFolder: false,
      mimeType: 'application/octet-stream',
      size: 3000,
      lifecycleStatus: 'ACTIVE',
      createdAt: now,
      updatedAt: now,
    });

    locationRepo.insert({
      fileId: file1.id,
      googleAccountId: driveA.id,
      providerFileId: 'p-1',
      status: 'ACTIVE',
      size: 3000,
      mimeType: 'application/octet-stream',
      createdAt: now,
    });

    const file2 = fileRepo.insert({
      name: 'f2.bin',
      parentId: folder.id,
      isFolder: false,
      mimeType: 'application/octet-stream',
      size: 2000,
      lifecycleStatus: 'ACTIVE',
      createdAt: now,
      updatedAt: now,
    });

    locationRepo.insert({
      fileId: file2.id,
      googleAccountId: driveB.id,
      providerFileId: 'p-2',
      status: 'ACTIVE',
      size: 2000,
      mimeType: 'application/octet-stream',
      createdAt: now,
    });

    const trashedFile = fileRepo.insert({
      name: 'trashed.txt',
      parentId: null,
      isFolder: false,
      mimeType: 'text/plain',
      size: 500,
      lifecycleStatus: 'TRASHED',
      trashedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    // Record Operations Journal
    opRepo.insert({
      id: 'OP-UP-1',
      operationType: 'UPLOAD',
      destDriveId: driveA.id,
      requestedBytes: 3000,
      status: 'COMPLETED',
      createdAt: now,
    });

    opRepo.insert({
      id: 'OP-UP-2',
      operationType: 'UPLOAD',
      destDriveId: driveB.id,
      requestedBytes: 2000,
      status: 'COMPLETED',
      createdAt: now,
    });

    opRepo.insert({
      id: 'OP-DL-1',
      operationType: 'DOWNLOAD',
      sourceDriveId: driveA.id,
      requestedBytes: 1500,
      status: 'COMPLETED',
      createdAt: now,
    });

    migRepo.insert({
      operationId: 'OP-UP-1',
      fileId: file1.id,
      sourceDriveId: driveA.id,
      sourceProviderFileId: 'p-1',
      destDriveId: driveB.id,
      reason: 'CAPACITY_REBALANCE',
      bytesTransferred: 3000,
      status: 'COMPLETED',
      startedAt: now,
    });

    const stats = statsService.getStatistics();

    // Logical counts & size
    expect(stats.totalLogicalBytes).toBe(5000); // 3000 + 2000 (trashed 500 excluded)
    expect(stats.totalFiles).toBe(2);
    expect(stats.totalFolders).toBe(1);
    expect(stats.totalTrashItems).toBe(1);

    // Physical capacity reported across providers
    expect(stats.totalPhysicalBytes).toBe(15000); // 5000 + 10000
    expect(stats.totalCapacityBytes).toBe(50000); // 20000 + 30000
    expect(stats.totalFreeBytes).toBe(35000); // 15000 + 20000

    // Transfer metrics
    expect(stats.totalUploadedBytes).toBe(5000);
    expect(stats.totalDownloadedBytes).toBe(1500);
    expect(stats.totalMigratedBytes).toBe(3000);

    // Per-drive stats
    expect(stats.drives).toHaveLength(2);
    const driveAStats = stats.drives.find((d) => d.accountId === driveA.id);
    expect(driveAStats?.fileCount).toBe(1);
    expect(driveAStats?.totalCapacity).toBe(20000);
  });
});
