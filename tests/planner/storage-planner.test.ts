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
import { StoragePlanner } from '../../src/storage/planner/storage-planner.js';
import { InsufficientCapacityError } from '../../src/domain/errors.js';

describe('StoragePlanner Engine & Plan Scoring Suite', () => {
  let conn: DatabaseConnection;
  let fileRepo: FileRepository;
  let locationRepo: FileLocationRepository;
  let accountRepo: GoogleAccountRepository;
  let opRepo: StorageOperationRepository;
  let resRepo: StorageReservationRepository;
  let capacityService: CapacityService;
  let planner: StoragePlanner;

  beforeEach(() => {
    conn = createDatabaseConnection(':memory:');
    runMigrations(conn);

    fileRepo = new FileRepository(conn.db);
    locationRepo = new FileLocationRepository(conn.db);
    accountRepo = new GoogleAccountRepository(conn.db);
    opRepo = new StorageOperationRepository(conn.db);
    resRepo = new StorageReservationRepository(conn.db);
    capacityService = new CapacityService(accountRepo, resRepo);

    planner = new StoragePlanner(capacityService, fileRepo, locationRepo, opRepo);
  });

  afterEach(() => {
    conn.close();
  });

  describe('Direct Placement Planning', () => {
    it('creates direct placement plan with MAX_USABLE_FREE_SPACE and 0 migrations', () => {
      const now = Date.now();
      const driveA = accountRepo.insert({
        email: 'a@gmail.com',
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
        email: 'b@gmail.com',
        displayName: 'Drive B',
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

      const plan = planner.createUploadPlan(8000);
      expect(plan.requiresMigration).toBe(false);
      expect(plan.targetDriveId).toBe(driveB.id);
      expect(plan.score).toBe(10000);
      expect(plan.migrationSteps).toHaveLength(0);
      expect(plan.capacityReservations).toHaveLength(1);
      expect(plan.capacityReservations[0].reservedBytes).toBe(8000);
      expect(plan.expectedFinalState.targetDriveUsableAfter).toBe(15000 - 8000);
      expect(plan.rejectedAlternatives.length).toBeGreaterThan(0);
    });
  });

  describe('Multi-Drive Migration Planning & Candidate Scoring', () => {
    it('formulates complete migration plan when direct placement is impossible', () => {
      const now = Date.now();

      // Drive A: 10,000 total, 4,000 used (has file_1 of 4,000 B), 6,000 free
      const driveA = accountRepo.insert({
        email: 'a@gmail.com',
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
        email: 'b@gmail.com',
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

      // Stored file on Drive A
      const file1 = fileRepo.insert({
        name: 'archive.tar',
        parentId: null,
        isFolder: false,
        mimeType: 'application/x-tar',
        size: 4000,
        lifecycleStatus: 'ACTIVE',
        createdAt: now - 100000000,
        updatedAt: now - 100000000,
      });

      locationRepo.insert({
        fileId: file1.id,
        googleAccountId: driveA.id,
        providerFileId: 'prov-file-1',
        status: 'ACTIVE',
        size: 4000,
        mimeType: 'application/x-tar',
        createdAt: now,
      });

      // Request upload of 9,000 B (neither A nor B has 9,000 B free directly)
      // Unified free space = 6,000 + 8,000 = 14,000 B >= 9,000 B
      const plan = planner.createUploadPlan(9000);

      expect(plan.requiresMigration).toBe(true);
      expect(plan.targetDriveId).toBe(driveA.id);
      expect(plan.migrationSteps).toHaveLength(1);
      expect(plan.migrationSteps[0].fileId).toBe(file1.id);
      expect(plan.migrationSteps[0].sourceDriveId).toBe(driveA.id);
      expect(plan.migrationSteps[0].destinationDriveId).toBe(driveB.id);

      // Verify reservations include incoming upload + migration destination
      expect(plan.capacityReservations).toHaveLength(2);
      expect(plan.capacityReservations).toContainEqual({
        driveId: driveA.id,
        reservedBytes: 9000,
        reason: 'INCOMING_UPLOAD',
      });
      expect(plan.capacityReservations).toContainEqual({
        driveId: driveB.id,
        reservedBytes: 4000,
        reason: 'MIGRATION_DESTINATION',
      });

      // Drive A usable after: 6,000 + 4,000 (cleared) - 9,000 = 1,000
      expect(plan.expectedFinalState.targetDriveUsableAfter).toBe(1000);
      // Drive B usable after: 8,000 - 4,000 = 4,000
      expect(plan.expectedFinalState.destinationDrivesUsableAfter[driveB.id]).toBe(4000);
    });

    it('respects migration lock on candidate source drives', () => {
      const now = Date.now();

      // Drive A: locked against migration
      const driveA = accountRepo.insert({
        email: 'locked@gmail.com',
        displayName: 'Locked Drive',
        totalSpace: 10000,
        usedSpace: 5000,
        freeSpace: 5000,
        reservedBytes: 0,
        migrationLocked: true, // LOCKED!
        status: 'AVAILABLE',
        encryptedCredentials: 'enc',
        createdAt: now,
        updatedAt: now,
      });

      // Drive B: free space
      accountRepo.insert({
        email: 'other@gmail.com',
        displayName: 'Other Drive',
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

      const file = fileRepo.insert({
        name: 'locked_file.bin',
        parentId: null,
        isFolder: false,
        mimeType: 'application/octet-stream',
        size: 4000,
        lifecycleStatus: 'ACTIVE',
        createdAt: now,
        updatedAt: now,
      });

      locationRepo.insert({
        fileId: file.id,
        googleAccountId: driveA.id,
        providerFileId: 'prov-locked',
        status: 'ACTIVE',
        size: 4000,
        mimeType: 'application/octet-stream',
        createdAt: now,
      });

      // Uploading 8,000 B requires evacuating Drive A, which is locked
      expect(() => {
        planner.createUploadPlan(8000);
      }).toThrow(InsufficientCapacityError);
    });

    it('rejects candidate plans when candidate files have no feasible destination', () => {
      const now = Date.now();

      // Drive A has a 4,000 B file and 6,000 B free
      const driveA = accountRepo.insert({
        email: 'driveA@gmail.com',
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

      // Drive B has only 2,000 B free (Cannot fit 4,000 B file!)
      accountRepo.insert({
        email: 'driveB@gmail.com',
        displayName: 'Drive B',
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

      const file = fileRepo.insert({
        name: 'huge.iso',
        parentId: null,
        isFolder: false,
        mimeType: 'application/x-iso',
        size: 4000,
        lifecycleStatus: 'ACTIVE',
        createdAt: now,
        updatedAt: now,
      });

      locationRepo.insert({
        fileId: file.id,
        googleAccountId: driveA.id,
        providerFileId: 'prov-iso',
        status: 'ACTIVE',
        size: 4000,
        mimeType: 'application/x-iso',
        createdAt: now,
      });

      // Upload 9,000 B cannot happen because 4,000 B file on A has nowhere to move
      expect(() => {
        planner.createUploadPlan(9000);
      }).toThrow(InsufficientCapacityError);
    });
  });
});
