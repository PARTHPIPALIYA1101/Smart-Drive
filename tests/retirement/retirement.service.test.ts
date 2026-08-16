import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';
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
import { MigrationPlanner } from '../../src/storage/migration/migration-planner.js';
import { MigrationExecutor } from '../../src/storage/migration/migration-executor.js';
import { ReservationManager } from '../../src/storage/reservation/reservation-manager.js';
import { DriveRetirementService } from '../../src/application/retirement/retirement.service.js';
import { StorageProviderFactory } from '../../src/providers/provider-factory.js';
import { InMemoryStorageProvider } from '../../src/providers/memory/in-memory-storage.provider.js';
import { InsufficientCapacityError } from '../../src/domain/errors.js';

describe('DriveRetirementService Suite', () => {
  let conn: DatabaseConnection;
  let fileRepo: FileRepository;
  let locationRepo: FileLocationRepository;
  let accountRepo: GoogleAccountRepository;
  let opRepo: StorageOperationRepository;
  let resRepo: StorageReservationRepository;
  let migRepo: FileMigrationRepository;
  let capacityService: CapacityService;
  let resManager: ReservationManager;
  let providerFactory: StorageProviderFactory;
  let migPlanner: MigrationPlanner;
  let executor: MigrationExecutor;
  let retirementService: DriveRetirementService;

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
    resManager = new ReservationManager(conn.db);
    providerFactory = new StorageProviderFactory();

    migPlanner = new MigrationPlanner(capacityService, fileRepo, locationRepo, accountRepo, opRepo);
    executor = new MigrationExecutor(
      fileRepo,
      locationRepo,
      accountRepo,
      opRepo,
      migRepo,
      resManager,
      providerFactory
    );
    retirementService = new DriveRetirementService(accountRepo, migPlanner, executor);
  });

  afterEach(() => {
    conn.close();
  });

  it('safely evacuates all files and marks account DISCONNECTED', async () => {
    const now = Date.now();

    const driveRetire = accountRepo.insert({
      email: 'old_drive@test.com',
      displayName: 'Old Drive',
      totalSpace: 10000,
      usedSpace: 2000,
      freeSpace: 8000,
      reservedBytes: 0,
      migrationLocked: false,
      status: 'AVAILABLE',
      encryptedCredentials: 'enc',
      createdAt: now,
      updatedAt: now,
    });

    const driveTarget = accountRepo.insert({
      email: 'new_drive@test.com',
      displayName: 'New Drive',
      totalSpace: 20000,
      usedSpace: 0,
      freeSpace: 20000,
      reservedBytes: 0,
      migrationLocked: false,
      status: 'AVAILABLE',
      encryptedCredentials: 'enc',
      createdAt: now,
      updatedAt: now,
    });

    const memOld = new InMemoryStorageProvider(10000);
    const memNew = new InMemoryStorageProvider(20000);
    providerFactory.registerMockProvider(driveRetire.id, memOld);
    providerFactory.registerMockProvider(driveTarget.id, memNew);

    const f1Meta = await memOld.uploadStream(Readable.from(Buffer.from('evacuate me')), {
      filename: 'data.txt',
      mimeType: 'text/plain',
      size: 11,
    });

    const file = fileRepo.insert({
      name: 'data.txt',
      parentId: null,
      isFolder: false,
      mimeType: 'text/plain',
      size: 11,
      lifecycleStatus: 'ACTIVE',
      createdAt: now,
      updatedAt: now,
    });

    locationRepo.insert({
      fileId: file.id,
      googleAccountId: driveRetire.id,
      providerFileId: f1Meta.providerFileId,
      status: 'ACTIVE',
      size: 11,
      mimeType: 'text/plain',
      createdAt: now,
    });

    const result = await retirementService.retireDrive(driveRetire.id);
    expect(result.success).toBe(true);
    expect(result.migratedCount).toBe(1);

    // Verify account is DISCONNECTED
    const updatedAccount = accountRepo.findById(driveRetire.id);
    expect(updatedAccount?.status).toBe('DISCONNECTED');

    // Verify file is now ACTIVE on new drive
    const activeLoc = locationRepo.findActiveByFileId(file.id);
    expect(activeLoc?.googleAccountId).toBe(driveTarget.id);
  });

  it('aborts retirement if other drives cannot hold all files', async () => {
    const now = Date.now();

    const driveRetire = accountRepo.insert({
      email: 'retire_fail@test.com',
      displayName: 'Retire Fail Drive',
      totalSpace: 10000,
      usedSpace: 9000,
      freeSpace: 1000,
      reservedBytes: 0,
      migrationLocked: false,
      status: 'AVAILABLE',
      encryptedCredentials: 'enc',
      createdAt: now,
      updatedAt: now,
    });

    const driveSmall = accountRepo.insert({
      email: 'small_drive@test.com',
      displayName: 'Small Drive',
      totalSpace: 10000,
      usedSpace: 8000,
      freeSpace: 2000, // Cannot hold 9000 B file!
      reservedBytes: 0,
      migrationLocked: false,
      status: 'AVAILABLE',
      encryptedCredentials: 'enc',
      createdAt: now,
      updatedAt: now,
    });

    const file = fileRepo.insert({
      name: 'huge.bin',
      parentId: null,
      isFolder: false,
      mimeType: 'application/octet-stream',
      size: 9000,
      lifecycleStatus: 'ACTIVE',
      createdAt: now,
      updatedAt: now,
    });

    locationRepo.insert({
      fileId: file.id,
      googleAccountId: driveRetire.id,
      providerFileId: 'p-huge',
      status: 'ACTIVE',
      size: 9000,
      mimeType: 'application/octet-stream',
      createdAt: now,
    });

    await expect(retirementService.retireDrive(driveRetire.id)).rejects.toThrow(
      InsufficientCapacityError
    );

    // Verify drive remains AVAILABLE (reverted safely)
    const account = accountRepo.findById(driveRetire.id);
    expect(account?.status).toBe('AVAILABLE');
  });
});
