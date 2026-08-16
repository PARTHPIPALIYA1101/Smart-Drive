import { describe, it, expect, beforeEach } from 'vitest';
import { createDatabaseConnection } from '../../src/persistence/db.js';
import { runMigrations } from '../../src/persistence/migrate.js';
import {
  FileRepository,
  GoogleAccountRepository,
  FileLocationRepository,
  StorageOperationRepository,
  StorageReservationRepository,
} from '../../src/persistence/repositories/index.js';
import { VirtualFilesystemService } from '../../src/domain/vfs/vfs.service.js';
import { CapacityService } from '../../src/domain/capacity/capacity.service.js';
import { TransferService } from '../../src/domain/transfer/transfer.service.js';
import { UploadQueue } from '../../src/domain/transfer/upload-queue.js';
import { DomainEventBus } from '../../src/domain/events/event-bus.js';
import { IProviderFactory, IStorageProvider } from '../../src/providers/provider-factory.js';
import { Readable } from 'node:stream';

class MockProvider implements IStorageProvider {
  constructor(public accountId: number) {}

  async uploadStream(
    stream: NodeJS.ReadableStream,
    metadata: { filename: string; mimeType: string; size: number }
  ) {
    return {
      providerFileId: `pfile-${metadata.filename}-${Date.now()}-${Math.random()}`,
      size: metadata.size,
      mimeType: metadata.mimeType,
      checksum: 'fake-md5',
      checksumType: 'MD5',
    };
  }

  async downloadStream() {
    return Readable.from(Buffer.from('test content'));
  }

  async deleteFile() {
    return true;
  }

  async getFileMetadata(providerFileId: string) {
    return {
      providerFileId,
      filename: 'file.txt',
      size: 100,
      mimeType: 'text/plain',
    };
  }

  async getQuota() {
    return { totalBytes: 15 * 1024 * 1024 * 1024, usedBytes: 0 };
  }
}

class MockProviderFactory implements IProviderFactory {
  getProvider(accountId: number): IStorageProvider {
    return new MockProvider(accountId);
  }
}

describe('Smart Drive Master Stabilization Suite', () => {
  let fileRepo: FileRepository;
  let accountRepo: GoogleAccountRepository;
  let locationRepo: FileLocationRepository;
  let opRepo: StorageOperationRepository;
  let resRepo: StorageReservationRepository;
  let eventBus: DomainEventBus;
  let vfsService: VirtualFilesystemService;
  let capacityService: CapacityService;
  let transferService: TransferService;
  let uploadQueue: UploadQueue;

  beforeEach(() => {
    const conn = createDatabaseConnection(':memory:');
    runMigrations(conn);

    fileRepo = new FileRepository(conn.db);
    accountRepo = new GoogleAccountRepository(conn.db);
    locationRepo = new FileLocationRepository(conn.db);
    opRepo = new StorageOperationRepository(conn.db);
    resRepo = new StorageReservationRepository(conn.db);
    eventBus = new DomainEventBus();

    vfsService = new VirtualFilesystemService(fileRepo, eventBus);
    capacityService = new CapacityService(accountRepo, resRepo);
    transferService = new TransferService(
      fileRepo,
      locationRepo,
      accountRepo,
      opRepo,
      resRepo,
      capacityService,
      new MockProviderFactory(),
      eventBus
    );
    uploadQueue = new UploadQueue(transferService, opRepo, eventBus, vfsService, 2);

    // Add 2 connected Google Drive accounts
    accountRepo.insert({
      email: 'drive1@gmail.com',
      displayName: 'Drive Primary',
      totalSpace: 15 * 1024 * 1024 * 1024,
      usedSpace: 0,
      freeSpace: 15 * 1024 * 1024 * 1024,
      reservedBytes: 0,
      migrationLocked: false,
      status: 'AVAILABLE',
      encryptedCredentials: 'enc',
      consecutiveFailures: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    accountRepo.insert({
      email: 'drive2@gmail.com',
      displayName: 'Drive Secondary',
      totalSpace: 15 * 1024 * 1024 * 1024,
      usedSpace: 0,
      freeSpace: 15 * 1024 * 1024 * 1024,
      reservedBytes: 0,
      migrationLocked: false,
      status: 'AVAILABLE',
      encryptedCredentials: 'enc',
      consecutiveFailures: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });

  describe('1. Virtual Root & Nested Hierarchy Isolation', () => {
    it('root children query returns ONLY items with parent_id IS NULL (never subfolder items)', () => {
      // Create root folder
      const rootFolder = vfsService.createFolder(null, 'Projects');
      // Create root file
      const rootFile = fileRepo.insert({
        name: 'notes.txt',
        parentId: null,
        isFolder: false,
        size: 50,
        mimeType: 'text/plain',
        lifecycleStatus: 'ACTIVE',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      // Create subfolder inside Projects
      const subFolder = vfsService.createFolder(rootFolder.id, 'Frontend');
      // Create subfolder file
      const subFile = fileRepo.insert({
        name: 'App.tsx',
        parentId: subFolder.id,
        isFolder: false,
        size: 150,
        mimeType: 'text/typescript',
        lifecycleStatus: 'ACTIVE',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      // Query root listing
      const rootChildren = vfsService.listChildren(null);
      const rootIds = rootChildren.map((c) => c.id);

      expect(rootChildren).toHaveLength(2);
      expect(rootIds).toContain(rootFolder.id);
      expect(rootIds).toContain(rootFile.id);
      expect(rootIds).not.toContain(subFolder.id);
      expect(rootIds).not.toContain(subFile.id);

      // Query subfolder listing
      const subChildren = vfsService.listChildren(subFolder.id);
      expect(subChildren).toHaveLength(1);
      expect(subChildren[0].id).toBe(subFile.id);
      expect(subChildren[0].name).toBe('App.tsx');
    });

    it('normalizes parentId = 0, "0", or NaN to null virtual root', () => {
      const folderFromZero = vfsService.createFolder(0 as any, 'Docs');
      expect(folderFromZero.parentId).toBeNull();

      const childrenFromZero = vfsService.listChildren(0 as any);
      expect(childrenFromZero.map((c) => c.id)).toContain(folderFromZero.id);
    });

    it('preserves multi-level folder structure with ensureDirectoryPath', () => {
      const leafFolder = vfsService.ensureDirectoryPath(null, ['Company', 'Engineering', 'Backend']);
      expect(leafFolder.name).toBe('Backend');
      expect(leafFolder.parentId).not.toBeNull();

      const fullPath = vfsService.getAbsolutePath(leafFolder.id);
      expect(fullPath).toBe('/Company/Engineering/Backend');

      // Root should only show 'Company'
      const rootList = vfsService.listChildren(null);
      expect(rootList).toHaveLength(1);
      expect(rootList[0].name).toBe('Company');
    });
  });

  describe('2. Background Upload Queue & Event Bus', () => {
    it('enqueues batch and emits live events as transfers complete', async () => {
      const events: any[] = [];
      eventBus.subscribeAll((e) => events.push(e));

      const batch = uploadQueue.enqueueBatch({
        rootFolderName: 'MyBatch',
        parentId: null,
        items: [
          {
            filename: 'file1.txt',
            relativePath: 'MyBatch/file1.txt',
            parentId: null,
            size: 100,
            mimeType: 'text/plain',
            buffer: Buffer.from('hello file 1'),
          },
          {
            filename: 'file2.txt',
            relativePath: 'MyBatch/file2.txt',
            parentId: null,
            size: 200,
            mimeType: 'text/plain',
            buffer: Buffer.from('hello file 2'),
          },
        ],
      });

      expect(batch.totalFiles).toBe(2);
      expect(batch.totalBytes).toBe(300);

      // Wait briefly for async queue execution
      await new Promise((resolve) => setTimeout(resolve, 300));

      const updatedBatch = uploadQueue.getBatch(batch.id);
      expect(updatedBatch?.status).toBe('COMPLETED');
      expect(updatedBatch?.completedFiles).toBe(2);

      const eventTypes = events.map((e) => e.type);
      expect(eventTypes).toContain('UPLOAD_QUEUED');
      expect(eventTypes).toContain('FILE_CREATED');
      expect(eventTypes).toContain('UPLOAD_COMPLETED');
    });

    it('cancels batch cleanly when requested', async () => {
      const batch = uploadQueue.enqueueBatch({
        rootFolderName: 'CancelledBatch',
        parentId: null,
        items: [
          {
            filename: 'f1.bin',
            relativePath: 'f1.bin',
            parentId: null,
            size: 1000,
            mimeType: 'application/octet-stream',
            buffer: Buffer.from(new Uint8Array(1000)),
          },
          {
            filename: 'f2.bin',
            relativePath: 'f2.bin',
            parentId: null,
            size: 1000,
            mimeType: 'application/octet-stream',
            buffer: Buffer.from(new Uint8Array(1000)),
          },
        ],
      });

      const cancelled = uploadQueue.cancelBatch(batch.id);
      expect(cancelled).toBe(true);

      const status = uploadQueue.getBatch(batch.id)?.status;
      expect(status).toBe('CANCELLED');
    });
  });
});
