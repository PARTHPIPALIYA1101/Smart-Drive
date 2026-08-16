import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabaseConnection, DatabaseConnection } from '../../src/persistence/db.js';
import { runMigrations } from '../../src/persistence/migrate.js';
import { GoogleAccountRepository } from '../../src/persistence/repositories/google-account.repository.js';
import { StorageReservationRepository } from '../../src/persistence/repositories/storage-reservation.repository.js';
import { StorageOperationRepository } from '../../src/persistence/repositories/storage-operation.repository.js';
import { CapacityService } from '../../src/domain/capacity/capacity.service.js';
import { DriveSyncService } from '../../src/application/sync/drive-sync.service.js';
import { AccountService } from '../../src/application/account/account.service.js';
import { StorageProviderFactory } from '../../src/providers/provider-factory.js';
import { InMemoryStorageProvider } from '../../src/providers/memory/in-memory-storage.provider.js';
import { TokenEncryptor } from '../../src/infrastructure/crypto/token-encryptor.js';
import { GoogleOAuthService } from '../../src/providers/google-drive/auth/google-oauth.service.js';

describe('Capacity Accounting & Drive Synchronization Suite', () => {
  let conn: DatabaseConnection;
  let accountRepo: GoogleAccountRepository;
  let resRepo: StorageReservationRepository;
  let opRepo: StorageOperationRepository;
  let capacityService: CapacityService;
  let syncService: DriveSyncService;
  let providerFactory: StorageProviderFactory;
  let accountService: AccountService;

  beforeEach(() => {
    conn = createDatabaseConnection(':memory:');
    runMigrations(conn);

    accountRepo = new GoogleAccountRepository(conn.db);
    resRepo = new StorageReservationRepository(conn.db);
    opRepo = new StorageOperationRepository(conn.db);
    capacityService = new CapacityService(accountRepo, resRepo);

    providerFactory = new StorageProviderFactory();
    const encryptor = new TokenEncryptor();
    const oauthService = new GoogleOAuthService(
      { clientId: 'c', clientSecret: 's', redirectUri: 'r' },
      encryptor,
      accountRepo
    );
    accountService = new AccountService(accountRepo, oauthService, encryptor);
    syncService = new DriveSyncService(accountRepo, providerFactory, accountService, capacityService);
  });

  afterEach(() => {
    conn.close();
  });

  describe('CapacityService Usable Calculation', () => {
    it('calculates usable capacity accounting for buffers and reservations', () => {
      const now = Date.now();
      const account = accountRepo.insert({
        email: 'drive1@gmail.com',
        displayName: 'Drive 1',
        totalSpace: 20000,
        usedSpace: 5000,
        freeSpace: 15000,
        reservedBytes: 2000, // 15000 - 2000 = 13000
        migrationLocked: false,
        status: 'AVAILABLE',
        encryptedCredentials: 'enc',
        createdAt: now,
        updatedAt: now,
      });

      const op = opRepo.insert({
        id: 'OP-CAP-1',
        operationType: 'UPLOAD',
        requestedBytes: 3000,
        status: 'RESERVED',
        createdAt: now,
      });

      resRepo.insert({
        googleAccountId: account.id,
        operationId: op.id,
        reservedBytes: 3000,
        status: 'ACTIVE',
        expiresAt: now + 60000,
        createdAt: now,
      });

      const snapshot = capacityService.getDriveCapacitySnapshot(account.id);
      expect(snapshot.totalSpace).toBe(20000);
      expect(snapshot.freeSpace).toBe(15000);
      expect(snapshot.reservedBytes).toBe(2000);
      expect(snapshot.activeReservations).toBe(3000);
      // Usable = 15000 - 2000 - 3000 = 10000
      expect(snapshot.usableSpace).toBe(10000);
    });

    it('returns zero usable capacity for unavailable or disconnected drives', () => {
      const now = Date.now();
      const account = accountRepo.insert({
        email: 'offline@gmail.com',
        displayName: 'Offline Drive',
        totalSpace: 50000,
        usedSpace: 0,
        freeSpace: 50000,
        reservedBytes: 0,
        migrationLocked: false,
        status: 'UNAVAILABLE',
        encryptedCredentials: 'enc',
        createdAt: now,
        updatedAt: now,
      });

      const snapshot = capacityService.getDriveCapacitySnapshot(account.id);
      expect(snapshot.usableSpace).toBe(0);
    });
  });

  describe('Unified Capacity Reporting', () => {
    it('aggregates multi-drive capacities and largest single-file capacity', () => {
      const now = Date.now();
      // Drive A: 10 GB free, usable = 10 GB
      accountRepo.insert({
        email: 'driveA@gmail.com',
        displayName: 'Drive A',
        totalSpace: 15000,
        usedSpace: 5000,
        freeSpace: 10000,
        reservedBytes: 0,
        migrationLocked: false,
        status: 'AVAILABLE',
        encryptedCredentials: 'enc',
        createdAt: now,
        updatedAt: now,
      });

      // Drive B: 20 GB free, 2 GB reserved, usable = 18 GB
      accountRepo.insert({
        email: 'driveB@gmail.com',
        displayName: 'Drive B',
        totalSpace: 30000,
        usedSpace: 10000,
        freeSpace: 20000,
        reservedBytes: 2000,
        migrationLocked: true,
        status: 'AVAILABLE',
        encryptedCredentials: 'enc',
        createdAt: now,
        updatedAt: now,
      });

      // Drive C: 50 GB free, but UNAVAILABLE (usable = 0)
      accountRepo.insert({
        email: 'driveC@gmail.com',
        displayName: 'Drive C',
        totalSpace: 60000,
        usedSpace: 10000,
        freeSpace: 50000,
        reservedBytes: 0,
        migrationLocked: false,
        status: 'UNAVAILABLE',
        encryptedCredentials: 'enc',
        createdAt: now,
        updatedAt: now,
      });

      const report = capacityService.getUnifiedCapacityReport();
      expect(report.connectedDrivesCount).toBe(3);
      expect(report.availableDrivesCount).toBe(2);
      expect(report.unavailableDrivesCount).toBe(1);
      expect(report.migrationLockedDrivesCount).toBe(1);

      expect(report.totalUnifiedBytes).toBe(105000);
      expect(report.totalUsedBytes).toBe(25000);
      expect(report.totalFreeBytes).toBe(80000);
      // Usable: Drive A (10000) + Drive B (18000) = 28000
      expect(report.totalUsableBytes).toBe(28000);
      // Largest single-file capacity = Drive B (18000)
      expect(report.largestSingleFileCapacity).toBe(18000);
    });
  });

  describe('DriveSyncService Synchronization & Failure Isolation', () => {
    it('synchronizes quota from providers and updates database state', async () => {
      const now = Date.now();
      const account = accountRepo.insert({
        email: 'sync_test@gmail.com',
        displayName: 'Sync Drive',
        totalSpace: 0,
        usedSpace: 0,
        freeSpace: 0,
        reservedBytes: 0,
        migrationLocked: false,
        status: 'AVAILABLE',
        encryptedCredentials: 'enc',
        createdAt: now,
        updatedAt: now,
      });

      const memProvider = new InMemoryStorageProvider(25000);
      providerFactory.registerMockProvider(account.id, memProvider);

      const snapshot = await syncService.syncAccountQuota(account.id);
      expect(snapshot.totalSpace).toBe(25000);
      expect(snapshot.freeSpace).toBe(25000);
      expect(snapshot.usedSpace).toBe(0);

      const inDb = accountRepo.findById(account.id);
      expect(inDb?.totalSpace).toBe(25000);
      expect(inDb?.freeSpace).toBe(25000);
      expect(inDb?.lastSyncedAt).toBeDefined();
    });

    it('isolates failure when one drive fails during unified sync', async () => {
      const now = Date.now();
      const driveA = accountRepo.insert({
        email: 'driveA@test.com',
        displayName: 'Drive A',
        totalSpace: 0,
        usedSpace: 0,
        freeSpace: 0,
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
        totalSpace: 0,
        usedSpace: 0,
        freeSpace: 0,
        reservedBytes: 0,
        migrationLocked: false,
        status: 'AVAILABLE',
        encryptedCredentials: 'enc',
        createdAt: now,
        updatedAt: now,
      });

      // Provider A is healthy
      const memA = new InMemoryStorageProvider(30000);
      providerFactory.registerMockProvider(driveA.id, memA);

      // Provider B fails quota calls
      const memB = new InMemoryStorageProvider(30000);
      memB.getQuota = async () => {
        throw new Error('Google API network timeout');
      };
      providerFactory.registerMockProvider(driveB.id, memB);

      // Unified sync must not throw, but handle Drive B failure gracefully
      const report = await syncService.syncAllAccounts();
      expect(report.connectedDrivesCount).toBe(2);

      // Drive A synced successfully
      const updatedA = accountRepo.findById(driveA.id);
      expect(updatedA?.totalSpace).toBe(30000);

      // Drive B failure recorded
      const updatedB = accountRepo.findById(driveB.id);
      expect(updatedB?.consecutiveFailures).toBe(1);
    });
  });
});
