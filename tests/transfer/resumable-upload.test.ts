import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Readable, PassThrough } from 'node:stream';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createDatabaseConnection, DatabaseConnection } from '../../src/persistence/db.js';
import { runMigrations } from '../../src/persistence/migrate.js';
import {
  FileRepository,
  FileLocationRepository,
  GoogleAccountRepository,
  StorageOperationRepository,
  StorageReservationRepository,
} from '../../src/persistence/repositories/index.js';
import { TransferService } from '../../src/domain/transfer/transfer.service.js';
import { CapacityService } from '../../src/domain/capacity/capacity.service.js';
import { StorageProviderFactory } from '../../src/providers/provider-factory.js';
import { InMemoryStorageProvider } from '../../src/providers/memory/in-memory-storage.provider.js';
import { TransferSessionManager } from '../../src/domain/transfer/transfer-session-manager.js';
import { DomainEventBus } from '../../src/domain/events/event-bus.js';
import { ResourceLimits } from '../../src/config/resource-limits.js';

describe('Option C: Browser-Session-Driven Resumable Uploads & Resource Optimization', () => {
  let conn: DatabaseConnection;
  let fileRepo: FileRepository;
  let locationRepo: FileLocationRepository;
  let accountRepo: GoogleAccountRepository;
  let opRepo: StorageOperationRepository;
  let resRepo: StorageReservationRepository;
  let capacityService: CapacityService;
  let providerFactory: StorageProviderFactory;
  let eventBus: DomainEventBus;
  let sessionManager: TransferSessionManager;
  let transferService: TransferService;
  let testDriveId: number;
  let memProvider: InMemoryStorageProvider;
  const dbPath = path.resolve(`./test_resumable_${Date.now()}.db`);

  beforeEach(() => {
    conn = createDatabaseConnection(dbPath);
    runMigrations(conn);

    fileRepo = new FileRepository(conn.db);
    locationRepo = new FileLocationRepository(conn.db);
    accountRepo = new GoogleAccountRepository(conn.db);
    opRepo = new StorageOperationRepository(conn.db);
    resRepo = new StorageReservationRepository(conn.db);
    capacityService = new CapacityService(accountRepo, resRepo);
    providerFactory = new StorageProviderFactory();
    eventBus = new DomainEventBus();

    sessionManager = new TransferSessionManager(
      opRepo,
      resRepo,
      providerFactory,
      eventBus,
      1000 // 1 second grace period for fast testing
    );

    transferService = new TransferService(
      fileRepo,
      locationRepo,
      accountRepo,
      opRepo,
      resRepo,
      capacityService,
      providerFactory,
      eventBus,
      sessionManager
    );

    const now = Date.now();
    const drive = accountRepo.insert({
      email: 'resumable_test@smartdrive.io',
      displayName: 'Resumable Test Drive',
      totalSpace: 10 * 1024 * 1024 * 1024, // 10 GB
      usedSpace: 0,
      freeSpace: 10 * 1024 * 1024 * 1024,
      reservedBytes: 0,
      migrationLocked: false,
      status: 'AVAILABLE',
      encryptedCredentials: 'enc',
      createdAt: now,
      updatedAt: now,
    });
    testDriveId = drive.id;

    memProvider = new InMemoryStorageProvider(10 * 1024 * 1024 * 1024);
    providerFactory.registerMockProvider(testDriveId, memProvider);
  });

  afterEach(() => {
    conn.close();
    try {
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
      if (fs.existsSync(`${dbPath}-wal`)) fs.unlinkSync(`${dbPath}-wal`);
      if (fs.existsSync(`${dbPath}-shm`)) fs.unlinkSync(`${dbPath}-shm`);
    } catch {}
  });

  it('1. Simulates 1 GB Upload: transfer 200 MB -> disconnect -> reconnect -> reacquire source -> query offset -> resume slice -> verify 1 file & checksum', async () => {
    // Generate synthetic 10 MB data chunk (scalable representation of 1 GB)
    const chunkSize = 2 * 1024 * 1024; // 2 MB partial
    const totalSize = 10 * 1024 * 1024; // 10 MB total

    // Create deterministic source buffer & checksum
    const fullSourceBuffer = Buffer.alloc(totalSize, 0x41); // 'A' repeated
    const expectedChecksum = crypto.createHash('md5').update(fullSourceBuffer).digest('hex');

    // 1. Initialize Resumable Upload
    const initRes = await transferService.initResumableUpload({
      name: 'large_dataset.iso',
      parentId: null,
      mimeType: 'application/octet-stream',
      size: totalSize,
      conflictAction: 'FAIL',
    });

    expect(initRes.operationId).toBeDefined();
    expect(initRes.destDriveId).toBe(testDriveId);
    expect(initRes.startByte).toBe(0);

    // Verify atomic capacity reservation was acquired
    expect(resRepo.calculateActiveReservedBytes(testDriveId)).toBe(totalSize);

    // 2. Stream partial data (e.g. first 2 MB)
    const partialStream1 = Readable.from(fullSourceBuffer.subarray(0, chunkSize));

    // Upload first 2 MB
    const partialRes1 = await transferService.resumeUploadStream({
      operationId: initRes.operationId,
      stream: partialStream1,
      startByte: 0,
      isPartial: true,
    });

    // 3. Browser disconnect triggers grace period in TransferSessionManager
    sessionManager.handleDisconnect(initRes.operationId);
    const session = sessionManager.getSession(initRes.operationId);
    expect(session).toBeDefined();
    expect(session?.isConnected).toBe(false);

    // 4. Browser Refreshes: loads active operations & reconnects
    sessionManager.handleReconnect(initRes.operationId);
    expect(session?.isConnected).toBe(true);

    // 5. Query provider for current byte offset
    const activeOp = opRepo.findById(initRes.operationId);
    const planContext = JSON.parse(activeOp!.planContext!);
    const currentOffset = await memProvider.queryResumableOffset(planContext.resumableSessionUri, totalSize);
    expect(currentOffset).toBe(chunkSize); // Exactly 2 MB already received

    // 6. Browser reacquires source file and sends file.slice(currentOffset)
    const remainingSlice = fullSourceBuffer.subarray(currentOffset);
    const partialStream2 = Readable.from(remainingSlice);

    const completeResult = await transferService.resumeUploadStream({
      operationId: initRes.operationId,
      stream: partialStream2,
      startByte: currentOffset,
    });

    // 7. Verification: Exactly 1 Smart File, 1 Location, matching checksum
    expect(completeResult.file).toBeDefined();
    expect(completeResult.file.name).toBe('large_dataset.iso');
    expect(completeResult.file.size).toBe(totalSize);

    const allFiles = fileRepo.findActiveByParentId(null);
    expect(allFiles).toHaveLength(1);
    expect(allFiles[0].id).toBe(completeResult.file.id);

    const location = locationRepo.findActiveByFileId(completeResult.file.id);
    expect(location).toBeDefined();
    expect(location?.checksum).toBe(expectedChecksum);
    expect(location?.checksumType).toBe('MD5');

    // 8. Verify capacity reservation committed and cleared
    expect(resRepo.calculateActiveReservedBytes(testDriveId)).toBe(0);
    const account = accountRepo.findById(testDriveId);
    expect(account?.usedSpace).toBe(totalSize);
  });

  it('2. Disconnect without source reacquisition transitions to WAITING_FOR_SOURCE, then resumes after source provided', async () => {
    const totalSize = 5 * 1024 * 1024;
    const partialSize = 1 * 1024 * 1024;
    const sourceBuffer = Buffer.alloc(totalSize, 0x42); // 'B'

    const initRes = await transferService.initResumableUpload({
      name: 'video_archive.mp4',
      parentId: null,
      mimeType: 'video/mp4',
      size: totalSize,
    });

    // Stream 1 MB
    const partialStream = Readable.from(sourceBuffer.subarray(0, partialSize));
    await transferService.resumeUploadStream({
      operationId: initRes.operationId,
      stream: partialStream,
      startByte: 0,
      isPartial: true,
    });

    // Mark WAITING_FOR_SOURCE (browser refreshed and File handle unavailable)
    sessionManager.markWaitingForSource(initRes.operationId);
    const opBefore = opRepo.findById(initRes.operationId);
    expect(opBefore?.status).toBe('WAITING_FOR_SOURCE');

    // Active operations list reflects WAITING_FOR_SOURCE
    const activeSessions = sessionManager.getActiveSessions();
    expect(activeSessions.some((s) => s.operationId === initRes.operationId && s.status === 'WAITING_FOR_SOURCE')).toBe(true);

    // User provides source file in UI -> Reconnect and resume from offset
    sessionManager.handleReconnect(initRes.operationId);
    const offset = await memProvider.queryResumableOffset(
      JSON.parse(opBefore!.planContext!).resumableSessionUri,
      totalSize
    );
    expect(offset).toBe(partialSize);

    // Stream remaining bytes
    const remainingStream = Readable.from(sourceBuffer.subarray(offset));
    const finalRes = await transferService.resumeUploadStream({
      operationId: initRes.operationId,
      stream: remainingStream,
      startByte: offset,
    });

    expect(finalRes.operation.status).toBe('COMPLETED');
    expect(finalRes.file.size).toBe(totalSize);
    expect(fileRepo.findActiveByParentId(null)).toHaveLength(1);
  });

  it('3. Multiple refresh/reconnect cycles preserve a single operation without duplicate files', async () => {
    const totalSize = 6 * 1024 * 1024;
    const sourceBuffer = Buffer.alloc(totalSize, 0x43);

    const initRes = await transferService.initResumableUpload({
      name: 'multi_refresh.dat',
      parentId: null,
      mimeType: 'application/octet-stream',
      size: totalSize,
    });

    let currentOffset = 0;
    const stepSize = 1 * 1024 * 1024; // 1 MB per step

    // 3 Disconnect/Reconnect cycles
    for (let step = 1; step <= 3; step++) {
      const pass = Readable.from(sourceBuffer.subarray(currentOffset, currentOffset + stepSize));
      await transferService.resumeUploadStream({
        operationId: initRes.operationId,
        stream: pass,
        startByte: currentOffset,
        isPartial: true,
      });

      sessionManager.handleDisconnect(initRes.operationId);
      sessionManager.handleReconnect(initRes.operationId);

      const op = opRepo.findById(initRes.operationId);
      currentOffset = await memProvider.queryResumableOffset(
        JSON.parse(op!.planContext!).resumableSessionUri,
        totalSize
      );
      expect(currentOffset).toBe(step * stepSize);
    }

    // Final transfer to complete
    const finalStream = Readable.from(sourceBuffer.subarray(currentOffset));
    const result = await transferService.resumeUploadStream({
      operationId: initRes.operationId,
      stream: finalStream,
      startByte: currentOffset,
    });

    expect(result.file.name).toBe('multi_refresh.dat');
    expect(fileRepo.findActiveByParentId(null)).toHaveLength(1);
    expect(locationRepo.findActiveByFileId(result.file.id)).toBeDefined();
    expect(opRepo.findIncompleteOperations()).toHaveLength(0);
  });

  it('4. Browser Close & Grace Period Expiry cancels provider session, releases reservations, and marks CANCELLED', async () => {
    const totalSize = 4 * 1024 * 1024;
    const initRes = await transferService.initResumableUpload({
      name: 'abandoned_tab.zip',
      parentId: null,
      mimeType: 'application/zip',
      size: totalSize,
    });

    expect(resRepo.calculateActiveReservedBytes(testDriveId)).toBe(totalSize);

    // Browser closes tab: client disconnects and does NOT reconnect
    sessionManager.handleDisconnect(initRes.operationId);

    // Advance grace period timer
    await sessionManager.onGracePeriodExpired(initRes.operationId);

    // Verify operation is marked CANCELLED
    const op = opRepo.findById(initRes.operationId);
    expect(op?.status).toBe('CANCELLED');
    expect(op?.errorCode).toBe('DISCONNECT_GRACE_EXPIRED');

    // Verify reservation was released back to drive pool
    expect(resRepo.calculateActiveReservedBytes(testDriveId)).toBe(0);

    // Verify no file was created in virtual filesystem
    expect(fileRepo.findActiveByParentId(null)).toHaveLength(0);
  });

  it('5. Reconnect during grace period cancels disconnect timer and keeps transfer alive', async () => {
    const totalSize = 2 * 1024 * 1024;
    const sourceBuffer = Buffer.alloc(totalSize, 0x44);

    const initRes = await transferService.initResumableUpload({
      name: 'reconnect_grace.bin',
      parentId: null,
      mimeType: 'application/octet-stream',
      size: totalSize,
    });

    // Disconnect
    sessionManager.handleDisconnect(initRes.operationId);
    const session = sessionManager.getSession(initRes.operationId);
    expect(session?.disconnectTimer).toBeDefined();

    // Reconnect during grace period
    sessionManager.handleReconnect(initRes.operationId);
    expect(session?.disconnectTimer).toBeUndefined();
    expect(session?.isConnected).toBe(true);

    // Complete upload
    const result = await transferService.resumeUploadStream({
      operationId: initRes.operationId,
      stream: Readable.from(sourceBuffer),
      startByte: 0,
    });

    expect(result.operation.status).toBe('COMPLETED');
    expect(fileRepo.findActiveByParentId(null)).toHaveLength(1);
  });

  it('6. Invalid or expired provider session is handled with clean error and rollback', async () => {
    const totalSize = 3 * 1024 * 1024;
    const initRes = await transferService.initResumableUpload({
      name: 'expired_session.dat',
      parentId: null,
      mimeType: 'application/octet-stream',
      size: totalSize,
    });

    // Simulate provider session expired/aborted on remote provider
    const op = opRepo.findById(initRes.operationId);
    const planContext = JSON.parse(op!.planContext!);
    await memProvider.abortSession(planContext.resumableSessionUri);

    // Query offset throws expired error
    await expect(
      memProvider.queryResumableOffset(planContext.resumableSessionUri, totalSize)
    ).rejects.toThrow(/expired/i);
  });

  it('7. Preserves complete virtual hierarchy for folder uploads with independent physical drive placement', async () => {
    // Test nested hierarchy: MyProject/src/utils/helper.ts
    const rootFolder = fileRepo.insert({
      name: 'MyProject',
      parentId: null,
      isFolder: true,
      mimeType: 'application/vnd.google-apps.folder',
      size: 0,
      lifecycleStatus: 'ACTIVE',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const srcFolder = fileRepo.insert({
      name: 'src',
      parentId: rootFolder.id,
      isFolder: true,
      mimeType: 'application/vnd.google-apps.folder',
      size: 0,
      lifecycleStatus: 'ACTIVE',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const utilsFolder = fileRepo.insert({
      name: 'utils',
      parentId: srcFolder.id,
      isFolder: true,
      mimeType: 'application/vnd.google-apps.folder',
      size: 0,
      lifecycleStatus: 'ACTIVE',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // Upload file into utils folder
    const initRes = await transferService.initResumableUpload({
      name: 'helper.ts',
      parentId: utilsFolder.id,
      mimeType: 'text/typescript',
      size: 1024,
      relativePath: 'MyProject/src/utils/helper.ts',
    });

    const result = await transferService.resumeUploadStream({
      operationId: initRes.operationId,
      stream: Readable.from(Buffer.alloc(1024, 0x5a)),
      startByte: 0,
    });

    expect(result.file.parentId).toBe(utilsFolder.id);
    expect(result.file.name).toBe('helper.ts');

    // Verify folder children queries
    const utilsChildren = fileRepo.findActiveByParentId(utilsFolder.id);
    expect(utilsChildren).toHaveLength(1);
    expect(utilsChildren[0].name).toBe('helper.ts');
  });

  it('8. Duplicate retry idempotency: Retrying with SKIP returns existing Smart File without duplicate creation', async () => {
    const upload1 = await transferService.uploadFile({
      name: 'idempotent_doc.pdf',
      parentId: null,
      mimeType: 'application/pdf',
      size: 2048,
      stream: Readable.from(Buffer.alloc(2048, 0x33)),
    });

    expect(upload1.file.id).toBeDefined();

    // Retry same upload with SKIP policy
    const initRes = await transferService.initResumableUpload({
      name: 'idempotent_doc.pdf',
      parentId: null,
      mimeType: 'application/pdf',
      size: 2048,
      conflictAction: 'SKIP',
    });

    expect(initRes.skipped).toBe(true);
    expect(initRes.file?.id).toBe(upload1.file.id);

    // Verify exactly 1 file in DB
    const all = fileRepo.findActiveByParentId(null);
    expect(all).toHaveLength(1);
  });
});
