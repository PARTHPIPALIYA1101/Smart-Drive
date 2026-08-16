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
import { StoragePlanner } from '../../src/storage/planner/storage-planner.js';
import { MigrationPlanner } from '../../src/storage/migration/migration-planner.js';
import { MigrationExecutor } from '../../src/storage/migration/migration-executor.js';
import { ReservationManager } from '../../src/storage/reservation/reservation-manager.js';
import { StorageProviderFactory } from '../../src/providers/provider-factory.js';
import { InMemoryStorageProvider } from '../../src/providers/memory/in-memory-storage.provider.js';
import { MigrationStep } from '../../src/storage/planner/planner.types.js';

describe('MigrationExecutor Safe State Machine Suite', () => {
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
  let planner: StoragePlanner;
  let migPlanner: MigrationPlanner;
  let executor: MigrationExecutor;

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

    planner = new StoragePlanner(capacityService, fileRepo, locationRepo, opRepo);
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
  });

  afterEach(() => {
    conn.close();
  });

  describe('Single-Step Safe Migration (Copy -> Verify -> Switch -> Cleanup)', () => {
    it('successfully executes migration step and atomically switches active location', async () => {
      const now = Date.now();

      const driveA = accountRepo.insert({
        email: 'driveA@test.com',
        displayName: 'Drive A',
        totalSpace: 10000,
        usedSpace: 3000,
        freeSpace: 7000,
        reservedBytes: 0,
        migrationLocked: false,
        status: 'AVAILABLE',
        encryptedCredentials: 'enc',
        createdAt: now,
        updatedAt: now,
      });

      const driveB = accountRepo.insert({
        email: 'driveB@test.com',
        displayName: 'Drive B',
        totalSpace: 10000,
        usedSpace: 1000,
        freeSpace: 9000,
        reservedBytes: 0,
        migrationLocked: false,
        status: 'AVAILABLE',
        encryptedCredentials: 'enc',
        createdAt: now,
        updatedAt: now,
      });

      const memA = new InMemoryStorageProvider(10000);
      const memB = new InMemoryStorageProvider(10000);
      providerFactory.registerMockProvider(driveA.id, memA);
      providerFactory.registerMockProvider(driveB.id, memB);

      // Upload file on Drive A initially
      const fileData = Buffer.from('Important Video Content Data');
      const uploadMeta = await memA.uploadStream(Readable.from(fileData), {
        filename: 'video.mp4',
        mimeType: 'video/mp4',
        size: fileData.length,
      });

      const file = fileRepo.insert({
        name: 'video.mp4',
        parentId: null,
        isFolder: false,
        mimeType: 'video/mp4',
        size: fileData.length,
        lifecycleStatus: 'ACTIVE',
        createdAt: now,
        updatedAt: now,
      });

      locationRepo.insert({
        fileId: file.id,
        googleAccountId: driveA.id,
        providerFileId: uploadMeta.providerFileId,
        status: 'ACTIVE',
        size: fileData.length,
        mimeType: 'video/mp4',
        checksum: uploadMeta.checksum,
        checksumType: 'MD5',
        createdAt: now,
      });

      const step: MigrationStep = {
        fileId: file.id,
        filename: 'video.mp4',
        sourceDriveId: driveA.id,
        sourceProviderFileId: uploadMeta.providerFileId,
        destinationDriveId: driveB.id,
        fileSizeBytes: fileData.length,
      };

      const migration = await executor.executeMigrationStep(step, 'OP-TEST-MIG', 'MANUAL_REQUEST');
      expect(migration.status).toBe('COMPLETED');
      expect(migration.bytesTransferred).toBe(fileData.length);

      // Verify active location in DB is now on Drive B
      const activeLoc = locationRepo.findActiveByFileId(file.id);
      expect(activeLoc).toBeDefined();
      expect(activeLoc?.googleAccountId).toBe(driveB.id);

      // Verify physical source deleted on Drive A
      await expect(memA.getFileMetadata(uploadMeta.providerFileId)).rejects.toThrow();

      // Verify destination exists and readable on Drive B
      const dlStream = await memB.downloadStream(activeLoc!.providerFileId);
      const chunks: Buffer[] = [];
      for await (const chunk of dlStream) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks).toString()).toBe('Important Video Content Data');
    });

    it('safely rolls back when copy to destination fails (source preserved)', async () => {
      const now = Date.now();

      const driveA = accountRepo.insert({
        email: 'driveA@test.com',
        displayName: 'Drive A',
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

      const driveB = accountRepo.insert({
        email: 'driveB@test.com',
        displayName: 'Drive B',
        totalSpace: 10000,
        usedSpace: 0,
        freeSpace: 10000,
        reservedBytes: 0,
        migrationLocked: false,
        status: 'AVAILABLE',
        encryptedCredentials: 'enc',
        createdAt: now,
        updatedAt: now,
      });

      const memA = new InMemoryStorageProvider(10000);
      const memB = new InMemoryStorageProvider(10000);
      memB.failNextUpload = true; // Inject upload failure on destination!

      providerFactory.registerMockProvider(driveA.id, memA);
      providerFactory.registerMockProvider(driveB.id, memB);

      const content = Buffer.from('Preserve My Data');
      const uploadMeta = await memA.uploadStream(Readable.from(content), {
        filename: 'safe.txt',
        mimeType: 'text/plain',
        size: content.length,
      });

      const file = fileRepo.insert({
        name: 'safe.txt',
        parentId: null,
        isFolder: false,
        mimeType: 'text/plain',
        size: content.length,
        lifecycleStatus: 'ACTIVE',
        createdAt: now,
        updatedAt: now,
      });

      locationRepo.insert({
        fileId: file.id,
        googleAccountId: driveA.id,
        providerFileId: uploadMeta.providerFileId,
        status: 'ACTIVE',
        size: content.length,
        mimeType: 'text/plain',
        createdAt: now,
      });

      const step: MigrationStep = {
        fileId: file.id,
        filename: 'safe.txt',
        sourceDriveId: driveA.id,
        sourceProviderFileId: uploadMeta.providerFileId,
        destinationDriveId: driveB.id,
        fileSizeBytes: content.length,
      };

      await expect(
        executor.executeMigrationStep(step, 'OP-FAIL-MIG', 'MANUAL_REQUEST')
      ).rejects.toThrow();

      // Source location remains ACTIVE on Drive A
      const activeLoc = locationRepo.findActiveByFileId(file.id);
      expect(activeLoc?.googleAccountId).toBe(driveA.id);
      expect(activeLoc?.status).toBe('ACTIVE');

      // Source physical file remains on Drive A
      const sourceMeta = await memA.getFileMetadata(uploadMeta.providerFileId);
      expect(sourceMeta.size).toBe(content.length);
    });
  });

  describe('End-to-End Multi-Step StoragePlan Execution', () => {
    it('plans and executes multi-drive rebalancing and upload', async () => {
      const now = Date.now();

      // Drive A: 10,000 total, 4,000 used (has 4,000 B file), 6,000 free
      const driveA = accountRepo.insert({
        email: 'a@test.com',
        displayName: 'Drive A',
        totalSpace: 10000,
        usedSpace: 4000,
        freeSpace: 6000,
        reservedBytes: 0,
        migrationLocked: false,
        status: 'AVAILABLE',
        encryptedCredentials: 'enc',
        createdAt: now,
        updatedAt: now,
      });

      // Drive B: 10,000 total, 2,000 used, 8,000 free
      const driveB = accountRepo.insert({
        email: 'b@test.com',
        displayName: 'Drive B',
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

      const memA = new InMemoryStorageProvider(10000);
      const memB = new InMemoryStorageProvider(10000);
      providerFactory.registerMockProvider(driveA.id, memA);
      providerFactory.registerMockProvider(driveB.id, memB);

      // Existing file on Drive A
      const file1Data = Buffer.from(''.padEnd(4000, '1'));
      const f1Meta = await memA.uploadStream(Readable.from(file1Data), {
        filename: 'f1.bin',
        mimeType: 'application/octet-stream',
        size: 4000,
      });

      const f1 = fileRepo.insert({
        name: 'f1.bin',
        parentId: null,
        isFolder: false,
        mimeType: 'application/octet-stream',
        size: 4000,
        lifecycleStatus: 'ACTIVE',
        createdAt: now - 100000000,
        updatedAt: now - 100000000,
      });

      locationRepo.insert({
        fileId: f1.id,
        googleAccountId: driveA.id,
        providerFileId: f1Meta.providerFileId,
        status: 'ACTIVE',
        size: 4000,
        mimeType: 'application/octet-stream',
        checksum: f1Meta.checksum,
        checksumType: 'MD5',
        createdAt: now,
      });

      // Request upload of 9,000 B file
      const plan = planner.createUploadPlan(9000);
      expect(plan.requiresMigration).toBe(true);
      expect(plan.targetDriveId).toBe(driveA.id);

      const incomingPayload = Buffer.from(''.padEnd(9000, 'N'));
      const op = await executor.executeStoragePlan(plan, {
        name: 'new_huge.bin',
        parentId: null,
        mimeType: 'application/octet-stream',
        size: 9000,
        stream: Readable.from(incomingPayload),
      });

      expect(op.status).toBe('COMPLETED');

      // Verify f1 migrated to Drive B
      const f1ActiveLoc = locationRepo.findActiveByFileId(f1.id);
      expect(f1ActiveLoc?.googleAccountId).toBe(driveB.id);

      // Verify new file uploaded to Drive A
      const newFile = fileRepo.findActiveByParentId(null).find((f) => f.name === 'new_huge.bin');
      expect(newFile).toBeDefined();
      const newFileLoc = locationRepo.findActiveByFileId(newFile!.id);
      expect(newFileLoc?.googleAccountId).toBe(driveA.id);
      expect(newFileLoc?.size).toBe(9000);
    });

    it('executes full Drive Evacuation plan for retirement', async () => {
      const now = Date.now();

      const driveRetiring = accountRepo.insert({
        email: 'retire@test.com',
        displayName: 'Retiring Drive',
        totalSpace: 10000,
        usedSpace: 5000,
        freeSpace: 5000,
        reservedBytes: 0,
        migrationLocked: false,
        status: 'AVAILABLE',
        encryptedCredentials: 'enc',
        createdAt: now,
        updatedAt: now,
      });

      const driveDest = accountRepo.insert({
        email: 'dest@test.com',
        displayName: 'Dest Drive',
        totalSpace: 20000,
        usedSpace: 2000,
        freeSpace: 18000,
        reservedBytes: 0,
        migrationLocked: false,
        status: 'AVAILABLE',
        encryptedCredentials: 'enc',
        createdAt: now,
        updatedAt: now,
      });

      const memSource = new InMemoryStorageProvider(10000);
      const memDest = new InMemoryStorageProvider(20000);
      providerFactory.registerMockProvider(driveRetiring.id, memSource);
      providerFactory.registerMockProvider(driveDest.id, memDest);

      const f1Data = Buffer.from('data 1');
      const meta1 = await memSource.uploadStream(Readable.from(f1Data), {
        filename: 'file1.txt',
        mimeType: 'text/plain',
        size: f1Data.length,
      });
      const file1 = fileRepo.insert({
        name: 'file1.txt',
        parentId: null,
        isFolder: false,
        mimeType: 'text/plain',
        size: f1Data.length,
        lifecycleStatus: 'ACTIVE',
        createdAt: now,
        updatedAt: now,
      });
      locationRepo.insert({
        fileId: file1.id,
        googleAccountId: driveRetiring.id,
        providerFileId: meta1.providerFileId,
        status: 'ACTIVE',
        size: f1Data.length,
        mimeType: 'text/plain',
        createdAt: now,
      });

      const evacPlan = migPlanner.planDriveEvacuation(driveRetiring.id, 'DRIVE_RETIREMENT');
      const migrations = await executor.executeEvacuationPlan(evacPlan);

      expect(migrations).toHaveLength(1);
      expect(migrations[0].status).toBe('COMPLETED');

      const activeLoc = locationRepo.findActiveByFileId(file1.id);
      expect(activeLoc?.googleAccountId).toBe(driveDest.id);
    });
  });
});
