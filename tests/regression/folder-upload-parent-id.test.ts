import { describe, it, expect, beforeEach } from 'vitest';
import { createDatabaseConnection } from '../../src/persistence/db.js';
import { runMigrations } from '../../src/persistence/migrate.js';
import {
  FileRepository,
  GoogleAccountRepository,
  FileLocationRepository,
  StorageOperationRepository,
  StorageReservationRepository,
  FileMigrationRepository,
} from '../../src/persistence/repositories/index.js';
import { VirtualFilesystemService } from '../../src/domain/vfs/vfs.service.js';
import { CapacityService } from '../../src/domain/capacity/capacity.service.js';
import { TransferService } from '../../src/domain/transfer/transfer.service.js';
import { UploadQueue } from '../../src/domain/transfer/upload-queue.js';
import { DomainEventBus } from '../../src/domain/events/event-bus.js';
import { CrashRecoveryEngine } from '../../src/storage/recovery/recovery-engine.js';
import { IProviderFactory, IStorageProvider } from '../../src/providers/provider-factory.js';
import { Readable } from 'node:stream';

class MockStorageProvider implements IStorageProvider {
  constructor(public accountId: number) {}

  async uploadStream(
    stream: NodeJS.ReadableStream,
    metadata: { filename: string; mimeType: string; size: number }
  ) {
    return {
      providerFileId: `provider-${metadata.filename}-${Date.now()}-${Math.random()}`,
      size: metadata.size,
      mimeType: metadata.mimeType,
      checksum: 'md5-sample-hash',
      checksumType: 'MD5',
    };
  }

  async downloadStream() {
    return Readable.from(Buffer.from('sample download content'));
  }

  async deleteFile() {
    return true;
  }

  async getFileMetadata(providerFileId: string) {
    return {
      providerFileId,
      filename: 'sample.txt',
      size: 100,
      mimeType: 'text/plain',
    };
  }

  async getQuota() {
    return { totalBytes: 30 * 1024 * 1024 * 1024, usedBytes: 0 };
  }
}

class MockProviderFactory implements IProviderFactory {
  getProvider(accountId: number): IStorageProvider {
    return new MockStorageProvider(accountId);
  }
}

describe('Smart Drive Folder Upload parent_id Preservation Suite', () => {
  let fileRepo: FileRepository;
  let accountRepo: GoogleAccountRepository;
  let locationRepo: FileLocationRepository;
  let opRepo: StorageOperationRepository;
  let resRepo: StorageReservationRepository;
  let migRepo: FileMigrationRepository;
  let eventBus: DomainEventBus;
  let vfsService: VirtualFilesystemService;
  let capacityService: CapacityService;
  let transferService: TransferService;
  let uploadQueue: UploadQueue;
  let dbConn: ReturnType<typeof createDatabaseConnection>;

  beforeEach(() => {
    dbConn = createDatabaseConnection(':memory:');
    runMigrations(dbConn);

    fileRepo = new FileRepository(dbConn.db);
    accountRepo = new GoogleAccountRepository(dbConn.db);
    locationRepo = new FileLocationRepository(dbConn.db);
    opRepo = new StorageOperationRepository(dbConn.db);
    resRepo = new StorageReservationRepository(dbConn.db);
    migRepo = new FileMigrationRepository(dbConn.db);
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
    uploadQueue = new UploadQueue(transferService, opRepo, eventBus, vfsService, 3);

    // Setup connected Google Drive accounts
    accountRepo.insert({
      email: 'primary@smartdrive.local',
      displayName: 'Google Drive 1',
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
      email: 'secondary@smartdrive.local',
      displayName: 'Google Drive 2',
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

  it('1. Folder with 2 files retains correct parent_id in DB and root listing', async () => {
    // Local:
    // MyFolder/
    // ├── file1.txt
    // └── file2.txt
    const batch = uploadQueue.enqueueBatch({
      rootFolderName: 'MyFolder',
      parentId: null,
      items: [
        {
          filename: 'file1.txt',
          relativePath: 'MyFolder/file1.txt',
          size: 100,
          mimeType: 'text/plain',
          buffer: Buffer.from('content 1'),
        },
        {
          filename: 'file2.txt',
          relativePath: 'MyFolder/file2.txt',
          size: 200,
          mimeType: 'text/plain',
          buffer: Buffer.from('content 2'),
        },
      ],
    });

    // Wait for queue completion
    await new Promise((resolve) => setTimeout(resolve, 350));

    // Verify DB records
    const allFolders = fileRepo.findActiveByParentId(null);
    expect(allFolders).toHaveLength(1);
    const myFolder = allFolders[0];
    expect(myFolder.name).toBe('MyFolder');
    expect(myFolder.parentId).toBeNull();
    expect(myFolder.isFolder).toBe(true);

    const folderChildren = fileRepo.findActiveByParentId(myFolder.id);
    expect(folderChildren).toHaveLength(2);

    const file1 = folderChildren.find((f) => f.name === 'file1.txt');
    const file2 = folderChildren.find((f) => f.name === 'file2.txt');

    expect(file1).toBeDefined();
    expect(file1!.parentId).toBe(myFolder.id);
    expect(file1!.isFolder).toBe(false);

    expect(file2).toBeDefined();
    expect(file2!.parentId).toBe(myFolder.id);
    expect(file2!.isFolder).toBe(false);

    // Verify VFS root list contains ONLY MyFolder, not file1 or file2
    const rootListing = vfsService.listChildren(null);
    expect(rootListing).toHaveLength(1);
    expect(rootListing[0].id).toBe(myFolder.id);
  });

  it('2. Folder with 25 files uploaded concurrently retains all parent_id values', async () => {
    const items = Array.from({ length: 25 }, (_, i) => ({
      filename: `file_${i + 1}.txt`,
      relativePath: `BigFolder/file_${i + 1}.txt`,
      size: 50 + i,
      mimeType: 'text/plain',
      buffer: Buffer.from(`data ${i}`),
    }));

    uploadQueue.enqueueBatch({
      rootFolderName: 'BigFolder',
      parentId: null,
      items,
    });

    // Wait for async processing
    await new Promise((resolve) => setTimeout(resolve, 600));

    // Root should only have BigFolder
    const rootListing = vfsService.listChildren(null);
    expect(rootListing).toHaveLength(1);
    const bigFolder = rootListing[0];
    expect(bigFolder.name).toBe('BigFolder');
    expect(bigFolder.parentId).toBeNull();

    // All 25 files must have parent_id = bigFolder.id
    const children = vfsService.listChildren(bigFolder.id);
    expect(children).toHaveLength(25);
    for (const child of children) {
      expect(child.parentId).toBe(bigFolder.id);
      expect(child.isFolder).toBe(false);
    }
  });

  it('3. Nested folders: preserves complete multi-level parent_id hierarchy', async () => {
    // Local:
    // MyProject/
    // ├── README.md
    // ├── package.json
    // └── src/
    //     ├── main.ts
    //     └── utils/
    //         └── helper.ts
    uploadQueue.enqueueBatch({
      rootFolderName: 'MyProject',
      parentId: null,
      items: [
        {
          filename: 'README.md',
          relativePath: 'MyProject/README.md',
          size: 120,
          mimeType: 'text/markdown',
          buffer: Buffer.from('# Readme'),
        },
        {
          filename: 'package.json',
          relativePath: 'MyProject/package.json',
          size: 200,
          mimeType: 'application/json',
          buffer: Buffer.from('{}'),
        },
        {
          filename: 'main.ts',
          relativePath: 'MyProject/src/main.ts',
          size: 300,
          mimeType: 'text/typescript',
          buffer: Buffer.from('console.log(1)'),
        },
        {
          filename: 'helper.ts',
          relativePath: 'MyProject/src/utils/helper.ts',
          size: 150,
          mimeType: 'text/typescript',
          buffer: Buffer.from('export const x = 1;'),
        },
      ],
    });

    await new Promise((resolve) => setTimeout(resolve, 400));

    // Root -> MyProject (parentId: null)
    const rootChildren = vfsService.listChildren(null);
    expect(rootChildren).toHaveLength(1);
    const myProject = rootChildren[0];
    expect(myProject.name).toBe('MyProject');
    expect(myProject.parentId).toBeNull();

    // MyProject -> README.md, package.json, src
    const projChildren = vfsService.listChildren(myProject.id);
    expect(projChildren).toHaveLength(3);
    const readme = projChildren.find((c) => c.name === 'README.md')!;
    const pkg = projChildren.find((c) => c.name === 'package.json')!;
    const src = projChildren.find((c) => c.name === 'src')!;

    expect(readme.parentId).toBe(myProject.id);
    expect(pkg.parentId).toBe(myProject.id);
    expect(src.parentId).toBe(myProject.id);
    expect(src.isFolder).toBe(true);

    // src -> main.ts, utils
    const srcChildren = vfsService.listChildren(src.id);
    expect(srcChildren).toHaveLength(2);
    const mainTs = srcChildren.find((c) => c.name === 'main.ts')!;
    const utils = srcChildren.find((c) => c.name === 'utils')!;

    expect(mainTs.parentId).toBe(src.id);
    expect(utils.parentId).toBe(src.id);
    expect(utils.isFolder).toBe(true);

    // utils -> helper.ts
    const utilsChildren = vfsService.listChildren(utils.id);
    expect(utilsChildren).toHaveLength(1);
    const helperTs = utilsChildren[0];
    expect(helperTs.name).toBe('helper.ts');
    expect(helperTs.parentId).toBe(utils.id);

    // Full absolute paths
    expect(vfsService.getAbsolutePath(helperTs.id)).toBe('/MyProject/src/utils/helper.ts');
    expect(vfsService.getAbsolutePath(mainTs.id)).toBe('/MyProject/src/main.ts');
  });

  it('4. Multiple folders uploaded simultaneously do not mix up parent_id values', async () => {
    uploadQueue.enqueueBatch({
      rootFolderName: 'FolderAlpha',
      parentId: null,
      items: [
        {
          filename: 'alpha1.txt',
          relativePath: 'FolderAlpha/alpha1.txt',
          size: 100,
          mimeType: 'text/plain',
          buffer: Buffer.from('a1'),
        },
        {
          filename: 'alpha2.txt',
          relativePath: 'FolderAlpha/alpha2.txt',
          size: 100,
          mimeType: 'text/plain',
          buffer: Buffer.from('a2'),
        },
      ],
    });

    uploadQueue.enqueueBatch({
      rootFolderName: 'FolderBeta',
      parentId: null,
      items: [
        {
          filename: 'beta1.txt',
          relativePath: 'FolderBeta/beta1.txt',
          size: 100,
          mimeType: 'text/plain',
          buffer: Buffer.from('b1'),
        },
        {
          filename: 'beta2.txt',
          relativePath: 'FolderBeta/beta2.txt',
          size: 100,
          mimeType: 'text/plain',
          buffer: Buffer.from('b2'),
        },
      ],
    });

    await new Promise((resolve) => setTimeout(resolve, 500));

    const rootList = vfsService.listChildren(null);
    expect(rootList).toHaveLength(2);

    const alphaFolder = rootList.find((f) => f.name === 'FolderAlpha')!;
    const betaFolder = rootList.find((f) => f.name === 'FolderBeta')!;

    expect(alphaFolder).toBeDefined();
    expect(betaFolder).toBeDefined();

    const alphaChildren = vfsService.listChildren(alphaFolder.id);
    expect(alphaChildren).toHaveLength(2);
    expect(alphaChildren.map((c) => c.name).sort()).toEqual(['alpha1.txt', 'alpha2.txt']);
    alphaChildren.forEach((c) => expect(c.parentId).toBe(alphaFolder.id));

    const betaChildren = vfsService.listChildren(betaFolder.id);
    expect(betaChildren).toHaveLength(2);
    expect(betaChildren.map((c) => c.name).sort()).toEqual(['beta1.txt', 'beta2.txt']);
    betaChildren.forEach((c) => expect(c.parentId).toBe(betaFolder.id));
  });

  it('5. Concurrent uploads: race condition in ensureDirectoryPath is safely handled', async () => {
    // Call ensureDirectoryPath in parallel on the same path
    const results = await Promise.all([
      Promise.resolve().then(() => vfsService.ensureDirectoryPath(null, ['ConcurrentFolder', 'sub'])),
      Promise.resolve().then(() => vfsService.ensureDirectoryPath(null, ['ConcurrentFolder', 'sub'])),
      Promise.resolve().then(() => vfsService.ensureDirectoryPath(null, ['ConcurrentFolder', 'sub'])),
    ]);

    // All should resolve to the exact same folder ID
    expect(results[0].id).toBe(results[1].id);
    expect(results[1].id).toBe(results[2].id);

    // Root should have only 1 'ConcurrentFolder'
    const rootNodes = vfsService.listChildren(null);
    expect(rootNodes.filter((n) => n.name === 'ConcurrentFolder')).toHaveLength(1);
  });

  it('6. Failed upload followed by retry preserves original parent_id and avoids duplicates', async () => {
    // Initial folder upload
    uploadQueue.enqueueBatch({
      rootFolderName: 'Docs',
      parentId: null,
      items: [
        {
          filename: 'doc1.pdf',
          relativePath: 'Docs/doc1.pdf',
          size: 100,
          mimeType: 'application/pdf',
          buffer: Buffer.from('pdf 1'),
          conflictAction: 'SKIP',
        },
      ],
    });

    await new Promise((resolve) => setTimeout(resolve, 250));

    const docsFolder = vfsService.findChildByName(null, 'Docs')!;
    expect(docsFolder).toBeDefined();

    // Re-upload with SKIP conflictAction (retry)
    uploadQueue.enqueueBatch({
      rootFolderName: 'Docs',
      parentId: null,
      items: [
        {
          filename: 'doc1.pdf',
          relativePath: 'Docs/doc1.pdf',
          size: 100,
          mimeType: 'application/pdf',
          buffer: Buffer.from('pdf 1'),
          conflictAction: 'SKIP',
        },
        {
          filename: 'doc2.pdf',
          relativePath: 'Docs/doc2.pdf',
          size: 120,
          mimeType: 'application/pdf',
          buffer: Buffer.from('pdf 2'),
          conflictAction: 'SKIP',
        },
      ],
    });

    await new Promise((resolve) => setTimeout(resolve, 350));

    const rootList = vfsService.listChildren(null);
    expect(rootList.filter((f) => f.name === 'Docs')).toHaveLength(1);

    const docChildren = vfsService.listChildren(docsFolder.id);
    expect(docChildren).toHaveLength(2);
    expect(docChildren.map((d) => d.name).sort()).toEqual(['doc1.pdf', 'doc2.pdf']);
    docChildren.forEach((d) => expect(d.parentId).toBe(docsFolder.id));
  });

  it('7. Application restart during folder upload leaves persistent DB hierarchy intact', async () => {
    // Create folder and record
    const rootFolder = vfsService.createFolder(null, 'SavedFolder');
    const file1 = fileRepo.insert({
      name: 'saved_file.txt',
      parentId: rootFolder.id,
      isFolder: false,
      size: 500,
      mimeType: 'text/plain',
      lifecycleStatus: 'ACTIVE',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // Simulate interrupted upload operation
    opRepo.insert({
      id: 'OP-INTERRUPTED',
      operationType: 'UPLOAD',
      destDriveId: 1,
      requestedBytes: 1000,
      status: 'RESERVED',
      createdAt: Date.now(),
    });

    // Perform crash recovery on startup
    const recoveryEngine = new CrashRecoveryEngine(
      opRepo,
      resRepo,
      locationRepo,
      migRepo,
      accountRepo,
      new MockProviderFactory()
    );

    const recoveryReport = await recoveryEngine.reconcileStartupState();
    expect(recoveryReport.recoveredCount).toBeGreaterThanOrEqual(1);

    // Verify parent_id in DB persists exactly
    const refetchedFile = fileRepo.findById(file1.id)!;
    expect(refetchedFile.parentId).toBe(rootFolder.id);
    expect(refetchedFile.name).toBe('saved_file.txt');

    const rootList = vfsService.listChildren(null);
    expect(rootList).toHaveLength(1);
    expect(rootList[0].id).toBe(rootFolder.id);
  });

  it('8. Exact User Test Case: Aditya Gadhvi / PHOTOS / IMG1.jpg, IMG2.jpg hierarchy integrity', async () => {
    // 1. Enqueue folder upload with nested path
    uploadQueue.enqueueBatch({
      rootFolderName: 'Aditya Gadhvi',
      parentId: null,
      items: [
        {
          filename: 'IMG20260129192625.jpg',
          relativePath: 'Aditya Gadhvi/PHOTOS/IMG20260129192625.jpg',
          size: 2048,
          mimeType: 'image/jpeg',
          buffer: Buffer.from('img data 1'),
        },
        {
          filename: 'IMG20260129191422.jpg',
          relativePath: 'Aditya Gadhvi/PHOTOS/IMG20260129191422.jpg',
          size: 4096,
          mimeType: 'image/jpeg',
          buffer: Buffer.from('img data 2'),
        },
      ],
    });

    await new Promise((resolve) => setTimeout(resolve, 400));

    // 2. Direct database query check
    const rootNodes = fileRepo.findActiveByParentId(null);
    expect(rootNodes).toHaveLength(1);
    const adityaFolder = rootNodes[0];
    expect(adityaFolder.name).toBe('Aditya Gadhvi');
    expect(adityaFolder.parentId).toBeNull();
    expect(adityaFolder.isFolder).toBe(true);

    const adityaChildren = fileRepo.findActiveByParentId(adityaFolder.id);
    expect(adityaChildren).toHaveLength(1);
    const photosFolder = adityaChildren[0];
    expect(photosFolder.name).toBe('PHOTOS');
    expect(photosFolder.parentId).toBe(adityaFolder.id);
    expect(photosFolder.isFolder).toBe(true);

    const photoFiles = fileRepo.findActiveByParentId(photosFolder.id);
    expect(photoFiles).toHaveLength(2);
    const img1 = photoFiles.find((f) => f.name === 'IMG20260129192625.jpg')!;
    const img2 = photoFiles.find((f) => f.name === 'IMG20260129191422.jpg')!;

    expect(img1).toBeDefined();
    expect(img1.parentId).toBe(photosFolder.id);
    expect(img1.lifecycleStatus).toBe('ACTIVE');

    expect(img2).toBeDefined();
    expect(img2.parentId).toBe(photosFolder.id);
    expect(img2.lifecycleStatus).toBe('ACTIVE');

    // 3. VFS Service Listing query checks
    expect(vfsService.listChildren(null)).toHaveLength(1);
    expect(vfsService.listChildren(null)[0].id).toBe(adityaFolder.id);

    expect(vfsService.listChildren(adityaFolder.id)).toHaveLength(1);
    expect(vfsService.listChildren(adityaFolder.id)[0].id).toBe(photosFolder.id);

    const photosListing = vfsService.listChildren(photosFolder.id);
    expect(photosListing).toHaveLength(2);
    expect(photosListing.map((p) => p.name).sort()).toEqual([
      'IMG20260129191422.jpg',
      'IMG20260129192625.jpg',
    ]);
  });

  it('9. Concurrency test: 50 concurrent files in nested hierarchy preserve individual parent_id', async () => {
    const items = Array.from({ length: 50 }, (_, i) => {
      const subDir = i % 2 === 0 ? 'subA' : 'subB';
      return {
        filename: `image_${i}.jpg`,
        relativePath: `MegaFolder/${subDir}/image_${i}.jpg`,
        size: 1000 + i,
        mimeType: 'image/jpeg',
        buffer: Buffer.from(`image content ${i}`),
      };
    });

    uploadQueue.enqueueBatch({
      rootFolderName: 'MegaFolder',
      parentId: null,
      items,
    });

    await new Promise((resolve) => setTimeout(resolve, 800));

    const megaFolder = vfsService.findChildByName(null, 'MegaFolder')!;
    expect(megaFolder).toBeDefined();

    const subFolders = vfsService.listChildren(megaFolder.id);
    expect(subFolders).toHaveLength(2);
    const subA = subFolders.find((f) => f.name === 'subA')!;
    const subB = subFolders.find((f) => f.name === 'subB')!;

    expect(subA).toBeDefined();
    expect(subB).toBeDefined();

    const subAFiles = vfsService.listChildren(subA.id);
    const subBFiles = vfsService.listChildren(subB.id);

    expect(subAFiles).toHaveLength(25);
    expect(subBFiles).toHaveLength(25);

    subAFiles.forEach((f) => expect(f.parentId).toBe(subA.id));
    subBFiles.forEach((f) => expect(f.parentId).toBe(subB.id));
  });
});
