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
import { CrashRecoveryEngine } from '../../src/storage/recovery/recovery-engine.js';
import { StorageProviderFactory } from '../../src/providers/provider-factory.js';
import { InMemoryStorageProvider } from '../../src/providers/memory/in-memory-storage.provider.js';
import { Readable } from 'node:stream';

describe('CrashRecoveryEngine Startup Reconciliation Suite', () => {
  let conn: DatabaseConnection;
  let fileRepo: FileRepository;
  let locationRepo: FileLocationRepository;
  let accountRepo: GoogleAccountRepository;
  let opRepo: StorageOperationRepository;
  let resRepo: StorageReservationRepository;
  let migRepo: FileMigrationRepository;
  let providerFactory: StorageProviderFactory;
  let recoveryEngine: CrashRecoveryEngine;

  beforeEach(() => {
    conn = createDatabaseConnection(':memory:');
    runMigrations(conn);

    fileRepo = new FileRepository(conn.db);
    locationRepo = new FileLocationRepository(conn.db);
    accountRepo = new GoogleAccountRepository(conn.db);
    opRepo = new StorageOperationRepository(conn.db);
    resRepo = new StorageReservationRepository(conn.db);
    migRepo = new FileMigrationRepository(conn.db);
    providerFactory = new StorageProviderFactory();

    recoveryEngine = new CrashRecoveryEngine(
      opRepo,
      resRepo,
      locationRepo,
      migRepo,
      accountRepo,
      providerFactory
    );
  });

  afterEach(() => {
    conn.close();
  });

  it('reconciles crash during RESERVED state (releases capacity and cancels op)', async () => {
    const now = Date.now();
    const drive = accountRepo.insert({
      email: 'drive@test.com',
      displayName: 'Drive',
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
      id: 'OP-CRASH-RESERVED',
      operationType: 'UPLOAD',
      destDriveId: drive.id,
      requestedBytes: 4000,
      status: 'RESERVED',
      createdAt: now,
    });

    resRepo.insert({
      googleAccountId: drive.id,
      operationId: op.id,
      reservedBytes: 4000,
      status: 'ACTIVE',
      expiresAt: now + 600000,
      createdAt: now,
    });

    expect(resRepo.calculateActiveReservedBytes(drive.id)).toBe(4000);

    const report = await recoveryEngine.reconcileStartupState();
    expect(report.recoveredCount).toBe(1);
    expect(report.results[0].resolution).toBe('CANCELLED');

    // Reservations freed
    expect(resRepo.calculateActiveReservedBytes(drive.id)).toBe(0);
    expect(opRepo.findById(op.id)?.status).toBe('CANCELLED');
  });

  it('reconciles crash during EXECUTING state (cleans up partial destination, preserves source)', async () => {
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
      usedSpace: 0,
      freeSpace: 10000,
      reservedBytes: 0,
      migrationLocked: false,
      status: 'AVAILABLE',
      encryptedCredentials: 'enc',
      createdAt: now,
      updatedAt: now,
    });

    const memB = new InMemoryStorageProvider(10000);
    providerFactory.registerMockProvider(driveB.id, memB);

    // Partial file created on Drive B before crash
    const partialMeta = await memB.uploadStream(Readable.from(Buffer.from('partial')), {
      filename: 'file.txt',
      mimeType: 'text/plain',
      size: 7,
    });

    const file = fileRepo.insert({
      name: 'file.txt',
      parentId: null,
      isFolder: false,
      mimeType: 'text/plain',
      size: 2000,
      lifecycleStatus: 'ACTIVE',
      createdAt: now,
      updatedAt: now,
    });

    // Authoritative source remains on Drive A
    locationRepo.insert({
      fileId: file.id,
      googleAccountId: driveA.id,
      providerFileId: 'prov-orig-a',
      status: 'ACTIVE',
      size: 2000,
      mimeType: 'text/plain',
      createdAt: now,
    });

    // Incomplete destination location on Drive B
    locationRepo.insert({
      fileId: file.id,
      googleAccountId: driveB.id,
      providerFileId: partialMeta.providerFileId,
      status: 'COPYING',
      size: 2000,
      mimeType: 'text/plain',
      createdAt: now,
    });

    const op = opRepo.insert({
      id: 'OP-CRASH-EXEC',
      operationType: 'PHYSICAL_MIGRATE',
      fileId: file.id,
      sourceDriveId: driveA.id,
      destDriveId: driveB.id,
      requestedBytes: 2000,
      status: 'EXECUTING',
      createdAt: now,
    });

    const report = await recoveryEngine.reconcileStartupState();
    expect(report.recoveredCount).toBe(1);
    expect(report.results[0].resolution).toBe('ROLLED_BACK');

    // Verify partial destination deleted on provider
    await expect(memB.getFileMetadata(partialMeta.providerFileId)).rejects.toThrow();

    // Source location remains ACTIVE on Drive A
    const activeLoc = locationRepo.findActiveByFileId(file.id);
    expect(activeLoc?.googleAccountId).toBe(driveA.id);
  });

  it('finalizes migration if crash occurred during VERIFYING after destination was complete', async () => {
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
    providerFactory.registerMockProvider(driveA.id, memA);
    providerFactory.registerMockProvider(driveB.id, memB);

    const fullContent = Buffer.from('Full Valid Content');
    const metaA = await memA.uploadStream(Readable.from(fullContent), {
      filename: 'intact.txt',
      mimeType: 'text/plain',
      size: fullContent.length,
    });
    const metaB = await memB.uploadStream(Readable.from(fullContent), {
      filename: 'intact.txt',
      mimeType: 'text/plain',
      size: fullContent.length,
    });

    const file = fileRepo.insert({
      name: 'intact.txt',
      parentId: null,
      isFolder: false,
      mimeType: 'text/plain',
      size: fullContent.length,
      lifecycleStatus: 'ACTIVE',
      createdAt: now,
      updatedAt: now,
    });

    locationRepo.insert({
      fileId: file.id,
      googleAccountId: driveA.id,
      providerFileId: metaA.providerFileId,
      status: 'ACTIVE',
      size: fullContent.length,
      mimeType: 'text/plain',
      createdAt: now,
    });

    locationRepo.insert({
      fileId: file.id,
      googleAccountId: driveB.id,
      providerFileId: metaB.providerFileId,
      status: 'VERIFIED',
      size: fullContent.length,
      mimeType: 'text/plain',
      createdAt: now,
    });

    opRepo.insert({
      id: 'OP-CRASH-VERIFY',
      operationType: 'PHYSICAL_MIGRATE',
      fileId: file.id,
      sourceDriveId: driveA.id,
      destDriveId: driveB.id,
      requestedBytes: fullContent.length,
      status: 'VERIFYING',
      createdAt: now,
    });

    const report = await recoveryEngine.reconcileStartupState();
    expect(report.recoveredCount).toBe(1);
    expect(report.results[0].resolution).toBe('FINALIZED');

    // Location switched to Drive B as ACTIVE
    const currentActive = locationRepo.findActiveByFileId(file.id);
    expect(currentActive?.googleAccountId).toBe(driveB.id);

    // Old source on Drive A deleted
    await expect(memA.getFileMetadata(metaA.providerFileId)).rejects.toThrow();
  });
});
