import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabaseConnection, DatabaseConnection } from '../../src/persistence/db.js';
import { runMigrations } from '../../src/persistence/migrate.js';
import {
  FileRepository,
  GoogleAccountRepository,
  FileLocationRepository,
  StorageOperationRepository,
  StorageReservationRepository,
} from '../../src/persistence/repositories/index.js';
import { CapacityService } from '../../src/domain/capacity/capacity.service.js';
import { MigrationPlanner } from '../../src/storage/migration/migration-planner.js';
import { InsufficientCapacityError } from '../../src/domain/errors.js';

describe('MigrationPlanner Engine Suite', () => {
  let conn: DatabaseConnection;
  let fileRepo: FileRepository;
  let locationRepo: FileLocationRepository;
  let accountRepo: GoogleAccountRepository;
  let opRepo: StorageOperationRepository;
  let resRepo: StorageReservationRepository;
  let capacityService: CapacityService;
  let migPlanner: MigrationPlanner;

  beforeEach(() => {
    conn = createDatabaseConnection(':memory:');
    runMigrations(conn);

    fileRepo = new FileRepository(conn.db);
    locationRepo = new FileLocationRepository(conn.db);
    accountRepo = new GoogleAccountRepository(conn.db);
    opRepo = new StorageOperationRepository(conn.db);
    resRepo = new StorageReservationRepository(conn.db);
    capacityService = new CapacityService(accountRepo, resRepo);

    migPlanner = new MigrationPlanner(
      capacityService,
      fileRepo,
      locationRepo,
      accountRepo,
      opRepo
    );
  });

  afterEach(() => {
    conn.close();
  });

  describe('Drive Retirement Evacuation Planning', () => {
    it('plans multi-drive file distribution for complete drive evacuation', () => {
      const now = Date.now();

      // Drive A (to be retired)
      const driveA = accountRepo.insert({
        email: 'retire_a@test.com',
        displayName: 'Drive A',
        totalSpace: 10000,
        usedSpace: 8000,
        freeSpace: 2000,
        reservedBytes: 0,
        migrationLocked: false,
        status: 'AVAILABLE',
        encryptedCredentials: 'enc',
        createdAt: now,
        updatedAt: now,
      });

      // Destination Drive B (5,000 B free)
      const driveB = accountRepo.insert({
        email: 'dest_b@test.com',
        displayName: 'Drive B',
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

      // Destination Drive C (5,000 B free)
      const driveC = accountRepo.insert({
        email: 'dest_c@test.com',
        displayName: 'Drive C',
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

      // 3 files on Drive A (4000, 3000, 1000 B)
      const f1 = fileRepo.insert({
        name: 'video.mp4',
        parentId: null,
        isFolder: false,
        mimeType: 'video/mp4',
        size: 4000,
        lifecycleStatus: 'ACTIVE',
        createdAt: now,
        updatedAt: now,
      });
      locationRepo.insert({
        fileId: f1.id,
        googleAccountId: driveA.id,
        providerFileId: 'prov-1',
        status: 'ACTIVE',
        size: 4000,
        mimeType: 'video/mp4',
        createdAt: now,
      });

      const f2 = fileRepo.insert({
        name: 'data.zip',
        parentId: null,
        isFolder: false,
        mimeType: 'application/zip',
        size: 3000,
        lifecycleStatus: 'ACTIVE',
        createdAt: now,
        updatedAt: now,
      });
      locationRepo.insert({
        fileId: f2.id,
        googleAccountId: driveA.id,
        providerFileId: 'prov-2',
        status: 'ACTIVE',
        size: 3000,
        mimeType: 'application/zip',
        createdAt: now,
      });

      const f3 = fileRepo.insert({
        name: 'notes.pdf',
        parentId: null,
        isFolder: false,
        mimeType: 'application/pdf',
        size: 1000,
        lifecycleStatus: 'ACTIVE',
        createdAt: now,
        updatedAt: now,
      });
      locationRepo.insert({
        fileId: f3.id,
        googleAccountId: driveA.id,
        providerFileId: 'prov-3',
        status: 'ACTIVE',
        size: 1000,
        mimeType: 'application/pdf',
        createdAt: now,
      });

      const evacPlan = migPlanner.planDriveEvacuation(driveA.id, 'DRIVE_RETIREMENT');

      expect(evacPlan.isFullyEvacuatable).toBe(true);
      expect(evacPlan.unmigratableFiles).toHaveLength(0);
      expect(evacPlan.migrationSteps).toHaveLength(3);
      expect(evacPlan.totalBytesToTransfer).toBe(8000);
      expect(evacPlan.capacityReservations).toHaveLength(3);
    });

    it('identifies unmigratable files when destination capacity cannot store complete file', () => {
      const now = Date.now();

      // Drive A has a large 8,000 B file
      const driveA = accountRepo.insert({
        email: 'source_a@test.com',
        displayName: 'Drive A',
        totalSpace: 10000,
        usedSpace: 8000,
        freeSpace: 2000,
        reservedBytes: 0,
        migrationLocked: false,
        status: 'AVAILABLE',
        encryptedCredentials: 'enc',
        createdAt: now,
        updatedAt: now,
      });

      // Drive B and C each only have 4,000 B free (Total = 8,000 B, but single file cannot be chunked!)
      accountRepo.insert({
        email: 'dest_b@test.com',
        displayName: 'Drive B',
        totalSpace: 10000,
        usedSpace: 6000,
        freeSpace: 4000,
        reservedBytes: 0,
        migrationLocked: false,
        status: 'AVAILABLE',
        encryptedCredentials: 'enc',
        createdAt: now,
        updatedAt: now,
      });

      accountRepo.insert({
        email: 'dest_c@test.com',
        displayName: 'Drive C',
        totalSpace: 10000,
        usedSpace: 6000,
        freeSpace: 4000,
        reservedBytes: 0,
        migrationLocked: false,
        status: 'AVAILABLE',
        encryptedCredentials: 'enc',
        createdAt: now,
        updatedAt: now,
      });

      const fLarge = fileRepo.insert({
        name: 'huge_backup.iso',
        parentId: null,
        isFolder: false,
        mimeType: 'application/x-iso',
        size: 8000,
        lifecycleStatus: 'ACTIVE',
        createdAt: now,
        updatedAt: now,
      });
      locationRepo.insert({
        fileId: fLarge.id,
        googleAccountId: driveA.id,
        providerFileId: 'prov-iso',
        status: 'ACTIVE',
        size: 8000,
        mimeType: 'application/x-iso',
        createdAt: now,
      });

      const evacPlan = migPlanner.planDriveEvacuation(driveA.id, 'DRIVE_RETIREMENT');

      expect(evacPlan.isFullyEvacuatable).toBe(false);
      expect(evacPlan.unmigratableFiles).toHaveLength(1);
      expect(evacPlan.unmigratableFiles[0].fileId).toBe(fLarge.id);
      expect(evacPlan.migrationSteps).toHaveLength(0);
    });
  });

  describe('Manual Single-File Migration Planning', () => {
    it('creates manual migration plan when target drive has space', () => {
      const now = Date.now();
      const driveA = accountRepo.insert({
        email: 'a@test.com',
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
        email: 'b@test.com',
        displayName: 'Drive B',
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

      const file = fileRepo.insert({
        name: 'doc.pdf',
        parentId: null,
        isFolder: false,
        mimeType: 'application/pdf',
        size: 2000,
        lifecycleStatus: 'ACTIVE',
        createdAt: now,
        updatedAt: now,
      });

      locationRepo.insert({
        fileId: file.id,
        googleAccountId: driveA.id,
        providerFileId: 'prov-doc',
        status: 'ACTIVE',
        size: 2000,
        mimeType: 'application/pdf',
        createdAt: now,
      });

      const plan = migPlanner.planSingleFileMigration(file.id, driveB.id);
      expect(plan.fileId).toBe(file.id);
      expect(plan.sourceDriveId).toBe(driveA.id);
      expect(plan.destinationDriveId).toBe(driveB.id);
      expect(plan.capacityReservation.reservedBytes).toBe(2000);
    });

    it('rejects manual migration if target drive has insufficient capacity', () => {
      const now = Date.now();
      const driveA = accountRepo.insert({
        email: 'a@test.com',
        displayName: 'Drive A',
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

      const driveB = accountRepo.insert({
        email: 'b@test.com',
        displayName: 'Drive B',
        totalSpace: 10000,
        usedSpace: 9000,
        freeSpace: 1000, // Only 1,000 B free
        reservedBytes: 0,
        migrationLocked: false,
        status: 'AVAILABLE',
        encryptedCredentials: 'enc',
        createdAt: now,
        updatedAt: now,
      });

      const file = fileRepo.insert({
        name: 'large.zip',
        parentId: null,
        isFolder: false,
        mimeType: 'application/zip',
        size: 3000, // 3,000 B > 1,000 B free
        lifecycleStatus: 'ACTIVE',
        createdAt: now,
        updatedAt: now,
      });

      locationRepo.insert({
        fileId: file.id,
        googleAccountId: driveA.id,
        providerFileId: 'prov-zip',
        status: 'ACTIVE',
        size: 3000,
        mimeType: 'application/zip',
        createdAt: now,
      });

      expect(() => {
        migPlanner.planSingleFileMigration(file.id, driveB.id);
      }).toThrow(InsufficientCapacityError);
    });
  });
});
