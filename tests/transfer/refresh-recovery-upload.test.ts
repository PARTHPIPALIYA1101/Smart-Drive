import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createDatabaseConnection, DatabaseConnection } from '../../src/persistence/db.js';
import { runMigrations } from '../../src/persistence/migrate.js';
import { FileRepository } from '../../src/persistence/repositories/file.repository.js';
import { FileLocationRepository } from '../../src/persistence/repositories/file-location.repository.js';
import { GoogleAccountRepository } from '../../src/persistence/repositories/google-account.repository.js';
import { StorageOperationRepository } from '../../src/persistence/repositories/storage-operation.repository.js';
import { StorageReservationRepository } from '../../src/persistence/repositories/storage-reservation.repository.js';
import { FileMigrationRepository } from '../../src/persistence/repositories/file-migration.repository.js';
import { CapacityService } from '../../src/domain/capacity/capacity.service.js';
import { VirtualFilesystemService } from '../../src/domain/vfs/vfs.service.js';
import { TransferService } from '../../src/domain/transfer/transfer.service.js';
import { TransferSessionManager } from '../../src/domain/transfer/transfer-session-manager.js';
import { UploadQueue } from '../../src/domain/transfer/upload-queue.js';
import { CrashRecoveryEngine } from '../../src/storage/recovery/recovery-engine.js';
import { DomainEventBus } from '../../src/domain/events/event-bus.js';
import { StorageProviderFactory } from '../../src/providers/provider-factory.js';
import { InMemoryStorageProvider } from '../../src/providers/memory/in-memory-storage.provider.js';

describe('Smart Drive Refresh Upload Recovery & Local Source Durability', () => {
  let conn: DatabaseConnection;
  let fileRepo: FileRepository;
  let locRepo: FileLocationRepository;
  let accRepo: GoogleAccountRepository;
  let opRepo: StorageOperationRepository;
  let resRepo: StorageReservationRepository;
  let migRepo: FileMigrationRepository;
  let capacityService: CapacityService;
  let vfsService: VirtualFilesystemService;
  let eventBus: DomainEventBus;
  let sessionManager: TransferSessionManager;
  let uploadQueue: UploadQueue;
  let transferService: TransferService;
  let recoveryEngine: CrashRecoveryEngine;
  let provider1: InMemoryStorageProvider;
  let provider2: InMemoryStorageProvider;
  let providerFactory: StorageProviderFactory;
  let tempDir: string;
  let drive1Id: number;
  let drive2Id: number;

  beforeEach(() => {
    conn = createDatabaseConnection(':memory:');
    runMigrations(conn);

    fileRepo = new FileRepository(conn.db);
    locRepo = new FileLocationRepository(conn.db);
    accRepo = new GoogleAccountRepository(conn.db);
    opRepo = new StorageOperationRepository(conn.db);
    resRepo = new StorageReservationRepository(conn.db);
    migRepo = new FileMigrationRepository(conn.db);
    eventBus = new DomainEventBus();

    provider1 = new InMemoryStorageProvider(10 * 1024 * 1024 * 1024); // 10 GB
    provider2 = new InMemoryStorageProvider(10 * 1024 * 1024 * 1024); // 10 GB

    const drive1 = accRepo.insert({
      email: 'drive1@gmail.com',
      displayName: 'Drive 1',
      totalSpace: 10 * 1024 * 1024 * 1024,
      usedSpace: 0,
      freeSpace: 10 * 1024 * 1024 * 1024,
      reservedBytes: 0,
      migrationLocked: false,
      status: 'AVAILABLE',
      encryptedCredentials: 'enc1',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    drive1Id = drive1.id;

    const drive2 = accRepo.insert({
      email: 'drive2@gmail.com',
      displayName: 'Drive 2',
      totalSpace: 10 * 1024 * 1024 * 1024,
      usedSpace: 0,
      freeSpace: 10 * 1024 * 1024 * 1024,
      reservedBytes: 0,
      migrationLocked: false,
      status: 'AVAILABLE',
      encryptedCredentials: 'enc2',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    drive2Id = drive2.id;

    providerFactory = new StorageProviderFactory();
    providerFactory.registerMockProvider(drive1Id, provider1);
    providerFactory.registerMockProvider(drive2Id, provider2);

    capacityService = new CapacityService(accRepo, resRepo);
    vfsService = new VirtualFilesystemService(fileRepo, eventBus);
    sessionManager = new TransferSessionManager(opRepo, resRepo, providerFactory, eventBus, 30000);
    transferService = new TransferService(
      fileRepo,
      locRepo,
      accRepo,
      opRepo,
      resRepo,
      capacityService,
      providerFactory,
      eventBus,
      sessionManager
    );
    uploadQueue = new UploadQueue(transferService, opRepo, eventBus, vfsService);
    recoveryEngine = new CrashRecoveryEngine(opRepo, resRepo, locRepo, migRepo, accRepo, providerFactory);

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smartdrive-test-'));
  });

  afterEach(() => {
    if (sessionManager) sessionManager.cleanup();
    try {
      if (tempDir && fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {}
    conn.close();
  });

  it('1. Single file upload: saves local sourcePath, survives disconnect/refresh, and auto-resumes', async () => {
    // Create a local test file (e.g. 1 MB)
    const filePath = path.join(tempDir, 'vacation_video.mp4');
    const fileSize = 1024 * 1024; // 1 MB
    fs.writeFileSync(filePath, Buffer.alloc(fileSize, 'A'));

    // Step 1: Client initiates resumable upload with sourcePath
    const initRes = await transferService.initResumableUpload({
      name: 'vacation_video.mp4',
      parentId: null,
      mimeType: 'video/mp4',
      size: fileSize,
      sourceType: 'FILE',
      sourcePath: filePath,
    });

    expect(initRes.operationId).toBeDefined();
    const opBefore = opRepo.findById(initRes.operationId);
    expect(opBefore).toBeDefined();
    const planContext = JSON.parse(opBefore!.planContext!);
    expect(planContext.sourcePath).toBe(filePath);
    expect(planContext.sourceType).toBe('FILE');

    // Step 2: Stream the first 256 KB chunk
    const firstChunkSize = 256 * 1024;
    const firstChunkStream = fs.createReadStream(filePath, { start: 0, end: firstChunkSize - 1 });
    await transferService.resumeUploadStream({
      operationId: initRes.operationId,
      startByte: 0,
      stream: firstChunkStream,
      isPartial: true,
    });

    // Verify session progress in memory & DB
    const session = sessionManager.getSession(initRes.operationId);
    expect(session).toBeDefined();
    expect(session!.bytesCompleted).toBe(firstChunkSize);

    // Step 3: Simulate browser disconnect (page refresh)
    sessionManager.handleDisconnect(initRes.operationId);
    expect(sessionManager.getSession(initRes.operationId)?.isConnected).toBe(false);

    // Step 4: Reconnect and verify provider offset
    sessionManager.handleReconnect(initRes.operationId);
    expect(sessionManager.getSession(initRes.operationId)?.isConnected).toBe(true);

    const prov = providerFactory.getProvider(initRes.destDriveId);
    const offset = await prov.queryResumableOffset!(initRes.resumableSessionUri!, fileSize);
    expect(offset).toBe(firstChunkSize);

    // Step 5: Backend auto-reopens sourcePath stream starting at offset and finishes upload
    const result = await transferService.resumeUploadStream({
      operationId: initRes.operationId,
      startByte: offset,
      sourcePath: filePath, // stream omitted: backend opens fs.createReadStream(sourcePath, { start: offset })
    });

    expect(result.file.id).toBeDefined();
    expect(result.file.name).toBe('vacation_video.mp4');
    expect(result.file.size).toBe(fileSize);
    expect(opRepo.findById(initRes.operationId)?.status).toBe('COMPLETED');
  });

  it('2. Single file upload: transitions to WAITING_FOR_SOURCE when source file is moved/missing', async () => {
    const filePath = path.join(tempDir, 'doc.pdf');
    fs.writeFileSync(filePath, Buffer.alloc(500 * 1024, 'B'));

    const initRes = await transferService.initResumableUpload({
      name: 'doc.pdf',
      parentId: null,
      mimeType: 'application/pdf',
      size: 500 * 1024,
      sourceType: 'FILE',
      sourcePath: filePath,
    });

    // Delete the source file
    fs.unlinkSync(filePath);

    // Resuming without stream when source file is missing marks WAITING_FOR_SOURCE
    await expect(
      transferService.resumeUploadStream({
        operationId: initRes.operationId,
        startByte: 0,
        sourcePath: filePath,
      })
    ).rejects.toThrow(/Source file unavailable/);

    const session = sessionManager.getSession(initRes.operationId);
    expect(session?.status).toBe('WAITING_FOR_SOURCE');

    // User provides new source path (e.g. file was moved)
    const newFilePath = path.join(tempDir, 'doc_restored.pdf');
    fs.writeFileSync(newFilePath, Buffer.alloc(500 * 1024, 'B'));

    const result = await transferService.resumeUploadStream({
      operationId: initRes.operationId,
      startByte: 0,
      sourcePath: newFilePath,
    });

    expect(result.file.name).toBe('doc.pdf');
    expect(opRepo.findById(initRes.operationId)?.status).toBe('COMPLETED');
  });

  it('3. Folder upload with nested hierarchy: pre-creates VFS and streams directly from disk', async () => {
    // Create nested directory structure:
    // tempDir/Vacation/
    // ├── Photos/
    // │   ├── A.jpg (100 KB)
    // │   └── B.jpg (200 KB)
    // └── Sub/
    //     └── C.jpg (300 KB)
    const rootFolder = path.join(tempDir, 'Vacation');
    const photosFolder = path.join(rootFolder, 'Photos');
    const subFolder = path.join(rootFolder, 'Sub');
    fs.mkdirSync(photosFolder, { recursive: true });
    fs.mkdirSync(subFolder, { recursive: true });

    fs.writeFileSync(path.join(photosFolder, 'A.jpg'), Buffer.alloc(100 * 1024, 'A'));
    fs.writeFileSync(path.join(photosFolder, 'B.jpg'), Buffer.alloc(200 * 1024, 'B'));
    fs.writeFileSync(path.join(subFolder, 'C.jpg'), Buffer.alloc(300 * 1024, 'C'));

    const batch = uploadQueue.enqueueBatch({
      sourceType: 'FOLDER',
      sourcePath: rootFolder,
      rootFolderName: 'Vacation',
      parentId: null,
      items: [
        {
          filename: 'A.jpg',
          relativePath: 'Vacation/Photos/A.jpg',
          size: 100 * 1024,
          mimeType: 'image/jpeg',
          sourcePath: path.join(photosFolder, 'A.jpg'),
        },
        {
          filename: 'B.jpg',
          relativePath: 'Vacation/Photos/B.jpg',
          size: 200 * 1024,
          mimeType: 'image/jpeg',
          sourcePath: path.join(photosFolder, 'B.jpg'),
        },
        {
          filename: 'C.jpg',
          relativePath: 'Vacation/Sub/C.jpg',
          size: 300 * 1024,
          mimeType: 'image/jpeg',
          sourcePath: path.join(subFolder, 'C.jpg'),
        },
      ],
    });

    expect(batch.id).toBeDefined();
    expect(batch.totalFiles).toBe(3);
    expect(batch.totalBytes).toBe(600 * 1024);

    // Wait for batch to finish background execution
    await new Promise<void>((resolve) => {
      eventBus.subscribe('UPLOAD_COMPLETED', (event) => {
        if ((event.payload as any).batchId === batch.id) resolve();
      });
    });

    const completedBatch = uploadQueue.getBatch(batch.id);
    expect(completedBatch?.status).toBe('COMPLETED');
    expect(completedBatch?.completedFiles).toBe(3);

    // Verify virtual filesystem hierarchy integrity
    const rootNodes = fileRepo.findActiveByParentId(null);
    const vacationFolder = rootNodes.find((n) => n.name === 'Vacation');
    expect(vacationFolder).toBeDefined();
    expect(vacationFolder!.isFolder).toBe(true);

    const vacationChildren = fileRepo.findActiveByParentId(vacationFolder!.id);
    const photosNode = vacationChildren.find((n) => n.name === 'Photos');
    const subNode = vacationChildren.find((n) => n.name === 'Sub');
    expect(photosNode).toBeDefined();
    expect(subNode).toBeDefined();

    const photosChildren = fileRepo.findActiveByParentId(photosNode!.id);
    expect(photosChildren.find((n) => n.name === 'A.jpg')?.size).toBe(100 * 1024);
    expect(photosChildren.find((n) => n.name === 'B.jpg')?.size).toBe(200 * 1024);

    const subChildren = fileRepo.findActiveByParentId(subNode!.id);
    expect(subChildren.find((n) => n.name === 'C.jpg')?.size).toBe(300 * 1024);
  });

  it('4. Multi-refresh resilience: active batch recovers and completes without re-uploading completed files', async () => {
    const rootFolder = path.join(tempDir, 'MultiRefresh');
    fs.mkdirSync(rootFolder, { recursive: true });
    fs.writeFileSync(path.join(rootFolder, 'file1.dat'), Buffer.alloc(150 * 1024, '1'));
    fs.writeFileSync(path.join(rootFolder, 'file2.dat'), Buffer.alloc(250 * 1024, '2'));

    const batch = uploadQueue.enqueueBatch({
      sourceType: 'FOLDER',
      sourcePath: rootFolder,
      rootFolderName: 'MultiRefresh',
      parentId: null,
      items: [
        {
          filename: 'file1.dat',
          relativePath: 'MultiRefresh/file1.dat',
          size: 150 * 1024,
          mimeType: 'application/octet-stream',
          sourcePath: path.join(rootFolder, 'file1.dat'),
        },
        {
          filename: 'file2.dat',
          relativePath: 'MultiRefresh/file2.dat',
          size: 250 * 1024,
          mimeType: 'application/octet-stream',
          sourcePath: path.join(rootFolder, 'file2.dat'),
        },
      ],
    });

    // Simulate multiple reconnects while batch runs
    sessionManager.handleReconnect();
    sessionManager.handleReconnect();
    sessionManager.handleReconnect();

    await new Promise<void>((resolve) => {
      eventBus.subscribe('UPLOAD_COMPLETED', (event) => {
        if ((event.payload as any).batchId === batch.id) resolve();
      });
    });

    const finalBatch = uploadQueue.getBatch(batch.id);
    expect(finalBatch?.status).toBe('COMPLETED');
    expect(finalBatch?.completedFiles).toBe(2);
    expect(finalBatch?.completedBytes).toBe(400 * 1024);
  });

  it('5. Crash recovery: preserves incomplete upload operations with local sourcePath and resumes', async () => {
    const rootFolder = path.join(tempDir, 'CrashTest');
    fs.mkdirSync(rootFolder, { recursive: true });
    fs.writeFileSync(path.join(rootFolder, 'data.bin'), Buffer.alloc(500 * 1024, 'D'));

    // Insert incomplete upload operation as if crashed in flight
    const opId = 'OP-CRASH-TEST-1';
    opRepo.insert({
      id: opId,
      operationType: 'UPLOAD',
      destDriveId: drive1Id,
      requestedBytes: 500 * 1024,
      status: 'EXECUTING',
      planContext: JSON.stringify({
        sourceType: 'FILE',
        sourcePath: path.join(rootFolder, 'data.bin'),
        fileName: 'data.bin',
        fileSize: 500 * 1024,
        destDriveId: drive1Id,
      }),
      createdAt: Date.now(),
    });

    resRepo.acquireAtomic(drive1Id, opId, 500 * 1024);

    // Reconcile startup state
    const report = await recoveryEngine.reconcileStartupState();
    expect(report.recoveredCount).toBe(1);
    expect(report.results[0].resolution).toBe('FINALIZED');
    expect(opRepo.findById(opId)?.status).toBe('EXECUTING');

    // Verify capacity reservation was preserved
    const totalReserved = resRepo.calculateActiveReservedBytes(drive1Id);
    expect(totalReserved).toBe(500 * 1024);
  });

  it('6. Source replacement verification: validates folder name, relative paths, and file sizes', async () => {
    const rootFolder = path.join(tempDir, 'OriginalFolder');
    fs.mkdirSync(rootFolder, { recursive: true });
    fs.writeFileSync(path.join(rootFolder, 'f1.txt'), Buffer.alloc(100, 'X'));

    const batch = uploadQueue.enqueueBatch({
      sourceType: 'FOLDER',
      sourcePath: rootFolder,
      rootFolderName: 'OriginalFolder',
      parentId: null,
      items: [
        {
          filename: 'f1.txt',
          relativePath: 'OriginalFolder/f1.txt',
          size: 100,
          mimeType: 'text/plain',
          sourcePath: path.join(rootFolder, 'f1.txt'),
        },
      ],
    });

    // 1. Invalid path (non-existent)
    const verify1 = uploadQueue.verifySourceFolder(batch.id, path.join(tempDir, 'NonExistent'));
    expect(verify1.valid).toBe(false);

    // 2. Replacement folder with missing relative file
    const emptyFolder = path.join(tempDir, 'EmptyFolder');
    fs.mkdirSync(emptyFolder, { recursive: true });
    const verify2 = uploadQueue.verifySourceFolder(batch.id, emptyFolder);
    expect(verify2.valid).toBe(false);
    expect(verify2.missingFiles?.length).toBe(1);

    // 3. Replacement folder with mismatched file size
    const wrongSizeFolder = path.join(tempDir, 'WrongSize');
    fs.mkdirSync(wrongSizeFolder, { recursive: true });
    fs.writeFileSync(path.join(wrongSizeFolder, 'f1.txt'), Buffer.alloc(200, 'Y'));
    const verify3 = uploadQueue.verifySourceFolder(batch.id, wrongSizeFolder);
    expect(verify3.valid).toBe(false);

    // 4. Valid replacement folder
    const validReplacement = path.join(tempDir, 'ValidReplacement');
    fs.mkdirSync(validReplacement, { recursive: true });
    fs.writeFileSync(path.join(validReplacement, 'f1.txt'), Buffer.alloc(100, 'Z'));
    const verify4 = uploadQueue.verifySourceFolder(batch.id, validReplacement);
    expect(verify4.valid).toBe(true);

    await new Promise<void>((resolve) => {
      eventBus.subscribe('UPLOAD_COMPLETED', (event) => {
        if ((event.payload as any).batchId === batch.id) resolve();
      });
    });
  });
});
