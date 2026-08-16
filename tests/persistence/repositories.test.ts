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
import { ReservationConflictError } from '../../src/domain/errors.js';

describe('Repositories Integration Suite', () => {
  let conn: DatabaseConnection;
  let fileRepo: FileRepository;
  let accountRepo: GoogleAccountRepository;
  let locationRepo: FileLocationRepository;
  let opRepo: StorageOperationRepository;
  let resRepo: StorageReservationRepository;
  let migRepo: FileMigrationRepository;

  beforeEach(() => {
    conn = createDatabaseConnection(':memory:');
    runMigrations(conn);

    fileRepo = new FileRepository(conn.db);
    accountRepo = new GoogleAccountRepository(conn.db);
    locationRepo = new FileLocationRepository(conn.db);
    opRepo = new StorageOperationRepository(conn.db);
    resRepo = new StorageReservationRepository(conn.db);
    migRepo = new FileMigrationRepository(conn.db);
  });

  afterEach(() => {
    conn.close();
  });

  describe('FileRepository', () => {
    it('creates root folders and files with proper hierarchy', () => {
      const now = Date.now();
      const folder = fileRepo.insert({
        name: 'Projects',
        parentId: null,
        isFolder: true,
        mimeType: 'application/x-directory',
        size: 0,
        lifecycleStatus: 'ACTIVE',
        createdAt: now,
        updatedAt: now,
      });

      expect(folder.id).toBeDefined();
      expect(folder.name).toBe('Projects');
      expect(folder.parentId).toBeNull();
      expect(folder.isFolder).toBe(true);

      const file = fileRepo.insert({
        name: 'app.zip',
        parentId: folder.id,
        isFolder: false,
        mimeType: 'application/zip',
        size: 1048576,
        lifecycleStatus: 'ACTIVE',
        createdAt: now,
        updatedAt: now,
      });

      expect(file.id).toBeDefined();
      expect(file.parentId).toBe(folder.id);

      const children = fileRepo.findActiveByParentId(folder.id);
      expect(children).toHaveLength(1);
      expect(children[0].name).toBe('app.zip');
    });

    it('traverses ancestor hierarchy correctly for cycle detection', () => {
      const now = Date.now();
      const rootFolder = fileRepo.insert({
        name: 'RootFolder',
        parentId: null,
        isFolder: true,
        mimeType: 'application/x-directory',
        size: 0,
        lifecycleStatus: 'ACTIVE',
        createdAt: now,
        updatedAt: now,
      });

      const subFolder = fileRepo.insert({
        name: 'SubFolder',
        parentId: rootFolder.id,
        isFolder: true,
        mimeType: 'application/x-directory',
        size: 0,
        lifecycleStatus: 'ACTIVE',
        createdAt: now,
        updatedAt: now,
      });

      const deepFolder = fileRepo.insert({
        name: 'DeepFolder',
        parentId: subFolder.id,
        isFolder: true,
        mimeType: 'application/x-directory',
        size: 0,
        lifecycleStatus: 'ACTIVE',
        createdAt: now,
        updatedAt: now,
      });

      const ancestors = fileRepo.getAncestorIds(deepFolder.id);
      expect(ancestors).toEqual([deepFolder.id, subFolder.id, rootFolder.id]);
    });

    it('handles trash and restore state transitions', () => {
      const now = Date.now();
      const file = fileRepo.insert({
        name: 'notes.txt',
        parentId: null,
        isFolder: false,
        mimeType: 'text/plain',
        size: 500,
        lifecycleStatus: 'ACTIVE',
        createdAt: now,
        updatedAt: now,
      });

      const trashed = fileRepo.trash(file.id);
      expect(trashed?.lifecycleStatus).toBe('TRASHED');
      expect(trashed?.trashedAt).toBeDefined();

      const activeList = fileRepo.findActiveByParentId(null);
      expect(activeList).toHaveLength(0);

      const restored = fileRepo.restore(file.id);
      expect(restored?.lifecycleStatus).toBe('ACTIVE');
      expect(restored?.trashedAt).toBeNull();
    });
  });

  describe('GoogleAccountRepository', () => {
    it('creates accounts and enforces unique email constraint', () => {
      const now = Date.now();
      const account = accountRepo.insert({
        email: 'drive1@gmail.com',
        displayName: 'Google Drive 1',
        totalSpace: 15000000000,
        usedSpace: 5000000000,
        freeSpace: 10000000000,
        reservedBytes: 1000000000,
        migrationLocked: false,
        status: 'AVAILABLE',
        encryptedCredentials: 'encrypted-token-blob',
        createdAt: now,
        updatedAt: now,
      });

      expect(account.id).toBeDefined();
      expect(account.email).toBe('drive1@gmail.com');
      expect(account.freeSpace).toBe(10000000000);

      // Duplicate email insertion must throw
      expect(() => {
        accountRepo.insert({
          email: 'drive1@gmail.com',
          displayName: 'Duplicate Drive',
          totalSpace: 15000000000,
          usedSpace: 0,
          freeSpace: 15000000000,
          reservedBytes: 0,
          migrationLocked: false,
          status: 'AVAILABLE',
          encryptedCredentials: 'encrypted-token-blob',
          createdAt: now,
          updatedAt: now,
        });
      }).toThrow();
    });

    it('toggles migration lock and updates capacity', () => {
      const now = Date.now();
      const account = accountRepo.insert({
        email: 'drive2@gmail.com',
        displayName: 'Google Drive 2',
        totalSpace: 20000000000,
        usedSpace: 5000000000,
        freeSpace: 15000000000,
        reservedBytes: 0,
        migrationLocked: false,
        status: 'AVAILABLE',
        encryptedCredentials: 'encrypted-token-blob',
        createdAt: now,
        updatedAt: now,
      });

      const locked = accountRepo.setMigrationLock(account.id, true);
      expect(locked?.migrationLocked).toBe(true);

      const updated = accountRepo.updateCapacity(account.id, 20000000000, 12000000000);
      expect(updated?.usedSpace).toBe(12000000000);
      expect(updated?.freeSpace).toBe(8000000000);
    });
  });

  describe('FileLocationRepository & Atomic Switching', () => {
    it('performs atomic location switch when migrating', () => {
      const now = Date.now();
      const file = fileRepo.insert({
        name: 'video.mp4',
        parentId: null,
        isFolder: false,
        mimeType: 'video/mp4',
        size: 500000000,
        lifecycleStatus: 'ACTIVE',
        createdAt: now,
        updatedAt: now,
      });

      const driveA = accountRepo.insert({
        email: 'driveA@gmail.com',
        displayName: 'Drive A',
        totalSpace: 10000000000,
        usedSpace: 1000000000,
        freeSpace: 9000000000,
        reservedBytes: 0,
        migrationLocked: false,
        status: 'AVAILABLE',
        encryptedCredentials: 'enc',
        createdAt: now,
        updatedAt: now,
      });

      const driveB = accountRepo.insert({
        email: 'driveB@gmail.com',
        displayName: 'Drive B',
        totalSpace: 10000000000,
        usedSpace: 1000000000,
        freeSpace: 9000000000,
        reservedBytes: 0,
        migrationLocked: false,
        status: 'AVAILABLE',
        encryptedCredentials: 'enc',
        createdAt: now,
        updatedAt: now,
      });

      // Initial active location on Drive A
      const locSource = locationRepo.insert({
        fileId: file.id,
        googleAccountId: driveA.id,
        providerFileId: 'provider-file-aaa',
        status: 'ACTIVE',
        size: 500000000,
        mimeType: 'video/mp4',
        checksum: 'provider-hash-1',
        checksumType: 'MD5',
        createdAt: now,
      });

      expect(locationRepo.findActiveByFileId(file.id)?.providerFileId).toBe('provider-file-aaa');

      // Copying to Drive B
      const locDest = locationRepo.insert({
        fileId: file.id,
        googleAccountId: driveB.id,
        providerFileId: 'provider-file-bbb',
        status: 'VERIFIED',
        size: 500000000,
        mimeType: 'video/mp4',
        checksum: 'provider-hash-1',
        checksumType: 'MD5',
        createdAt: now,
      });

      // Execute atomic switch
      const { newLocation, oldLocation } = locationRepo.switchActiveLocation(
        file.id,
        locDest.id,
        locSource.id
      );

      expect(newLocation.status).toBe('ACTIVE');
      expect(newLocation.providerFileId).toBe('provider-file-bbb');
      expect(oldLocation.status).toBe('OLD');

      const currentActive = locationRepo.findActiveByFileId(file.id);
      expect(currentActive?.id).toBe(locDest.id);
      expect(currentActive?.googleAccountId).toBe(driveB.id);
    });
  });

  describe('StorageReservationRepository & Atomic Lockouts', () => {
    it('atomically reserves capacity and rejects when capacity is exceeded', () => {
      const now = Date.now();
      const account = accountRepo.insert({
        email: 'drive_res@gmail.com',
        displayName: 'Reservation Test Drive',
        totalSpace: 10000,
        usedSpace: 2000,
        freeSpace: 8000,
        reservedBytes: 1000, // Usable = 8000 - 1000 = 7000
        migrationLocked: false,
        status: 'AVAILABLE',
        encryptedCredentials: 'enc',
        createdAt: now,
        updatedAt: now,
      });

      // Operation 1: Reserve 4000 bytes (Remaining usable = 3000)
      const op1 = opRepo.insert({
        id: 'OP-001',
        operationType: 'UPLOAD',
        requestedBytes: 4000,
        status: 'RESERVED',
        createdAt: now,
      });

      const res1 = resRepo.acquireAtomic(account.id, op1.id, 4000);
      expect(res1.status).toBe('ACTIVE');
      expect(res1.reservedBytes).toBe(4000);

      const activeReserved = resRepo.calculateActiveReservedBytes(account.id);
      expect(activeReserved).toBe(4000);

      // Operation 2: Attempt to reserve 3500 bytes (Exceeds remaining 3000 usable bytes)
      const op2 = opRepo.insert({
        id: 'OP-002',
        operationType: 'UPLOAD',
        requestedBytes: 3500,
        status: 'PENDING',
        createdAt: now,
      });

      expect(() => {
        resRepo.acquireAtomic(account.id, op2.id, 3500);
      }).toThrow(ReservationConflictError);

      // Operation 3: Reserve 2000 bytes (Fits in 3000)
      const op3 = opRepo.insert({
        id: 'OP-003',
        operationType: 'UPLOAD',
        requestedBytes: 2000,
        status: 'RESERVED',
        createdAt: now,
      });

      const res3 = resRepo.acquireAtomic(account.id, op3.id, 2000);
      expect(res3.status).toBe('ACTIVE');

      expect(resRepo.calculateActiveReservedBytes(account.id)).toBe(6000);

      // Releasing Op 1 releases 4000 bytes
      resRepo.releaseByOperationId(op1.id);
      expect(resRepo.calculateActiveReservedBytes(account.id)).toBe(2000);
    });

    it('expires stale reservations cleanly', () => {
      const now = Date.now();
      const account = accountRepo.insert({
        email: 'drive_exp@gmail.com',
        displayName: 'Expiry Drive',
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

      const op = opRepo.insert({
        id: 'OP-EXP-1',
        operationType: 'UPLOAD',
        requestedBytes: 3000,
        status: 'RESERVED',
        createdAt: now,
      });

      // Insert reservation that expired in the past
      resRepo.insert({
        googleAccountId: account.id,
        operationId: op.id,
        reservedBytes: 3000,
        status: 'ACTIVE',
        expiresAt: now - 5000,
        createdAt: now - 10000,
      });

      // Expired reservations should not count towards active reserved bytes
      expect(resRepo.calculateActiveReservedBytes(account.id)).toBe(0);

      const expiredCount = resRepo.expireOldReservations(now);
      expect(expiredCount).toBe(1);
    });
  });

  describe('StorageOperationRepository & Incomplete Operation Detection', () => {
    it('detects incomplete operations for crash recovery', () => {
      const now = Date.now();
      opRepo.insert({
        id: 'OP-CRASH-1',
        operationType: 'UPLOAD',
        status: 'EXECUTING',
        requestedBytes: 1000,
        createdAt: now,
      });

      opRepo.insert({
        id: 'OP-COMPLETED-1',
        operationType: 'UPLOAD',
        status: 'COMPLETED',
        requestedBytes: 1000,
        createdAt: now,
      });

      opRepo.insert({
        id: 'OP-CRASH-2',
        operationType: 'PHYSICAL_MIGRATE',
        status: 'VERIFYING',
        requestedBytes: 2000,
        createdAt: now,
      });

      const incomplete = opRepo.findIncompleteOperations();
      expect(incomplete).toHaveLength(2);
      expect(incomplete.map((op) => op.id)).toEqual(['OP-CRASH-1', 'OP-CRASH-2']);
    });
  });
});
