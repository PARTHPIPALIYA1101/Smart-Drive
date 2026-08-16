import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabaseConnection, DatabaseConnection } from '../../src/persistence/db.js';
import { runMigrations } from '../../src/persistence/migrate.js';
import { FileRepository } from '../../src/persistence/repositories/file.repository.js';
import { FileLocationRepository } from '../../src/persistence/repositories/file-location.repository.js';
import { GoogleAccountRepository } from '../../src/persistence/repositories/google-account.repository.js';
import { StorageOperationRepository } from '../../src/persistence/repositories/storage-operation.repository.js';
import { StorageReservationRepository } from '../../src/persistence/repositories/storage-reservation.repository.js';
import { CapacityService } from '../../src/domain/capacity/capacity.service.js';
import { VirtualFilesystemService } from '../../src/domain/vfs/vfs.service.js';
import { TransferService } from '../../src/domain/transfer/transfer.service.js';
import { StorageProviderFactory } from '../../src/providers/provider-factory.js';
import { InMemoryStorageProvider } from '../../src/providers/memory/in-memory-storage.provider.js';
import { InsufficientCapacityError } from '../../src/domain/errors.js';
import { Readable } from 'node:stream';

describe('Folder Upload & Unified Physical Storage', () => {
  let conn: DatabaseConnection;
  let fileRepo: FileRepository;
  let locationRepo: FileLocationRepository;
  let accountRepo: GoogleAccountRepository;
  let opRepo: StorageOperationRepository;
  let resRepo: StorageReservationRepository;
  let capacityService: CapacityService;
  let vfs: VirtualFilesystemService;
  let providerFactory: StorageProviderFactory;
  let transferService: TransferService;

  beforeEach(() => {
    conn = createDatabaseConnection(':memory:');
    runMigrations(conn);
    fileRepo = new FileRepository(conn.db);
    locationRepo = new FileLocationRepository(conn.db);
    accountRepo = new GoogleAccountRepository(conn.db);
    opRepo = new StorageOperationRepository(conn.db);
    resRepo = new StorageReservationRepository(conn.db);
    capacityService = new CapacityService(accountRepo, resRepo);
    vfs = new VirtualFilesystemService(fileRepo);
    providerFactory = new StorageProviderFactory();

    transferService = new TransferService(
      fileRepo,
      locationRepo,
      accountRepo,
      opRepo,
      resRepo,
      capacityService,
      providerFactory
    );
  });

  afterEach(() => {
    conn.close();
  });

  it('1. Single file upload works correctly', async () => {
    const drive = accountRepo.insert({
      email: 'drive1@gmail.com',
      displayName: 'Drive 1',
      totalSpace: 10000,
      usedSpace: 0,
      freeSpace: 10000,
      reservedBytes: 0,
      migrationLocked: false,
      status: 'AVAILABLE',
      encryptedCredentials: 'enc',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    providerFactory.registerMockProvider(drive.id, new InMemoryStorageProvider(10000));

    const result = await transferService.uploadFile({
      name: 'hello.txt',
      parentId: null,
      mimeType: 'text/plain',
      size: 100,
      stream: Readable.from(Buffer.from('hello world')),
    });

    expect(result.file.id).toBeGreaterThan(0);
    expect(result.file.name).toBe('hello.txt');
    expect(result.file.isFolder).toBe(false);
    expect(result.location.googleAccountId).toBe(drive.id);
  });

  it('2. Empty folder creation and preservation in VFS', () => {
    const emptyFolder = vfs.createFolder(null, 'EmptyFolder');
    expect(emptyFolder.id).toBeGreaterThan(0);
    expect(emptyFolder.name).toBe('EmptyFolder');
    expect(emptyFolder.isFolder).toBe(true);
    expect(vfs.listChildren(null)).toHaveLength(1);
    expect(vfs.listChildren(emptyFolder.id)).toHaveLength(0);
  });

  it('3. Folder with multiple files and virtual hierarchy preservation', async () => {
    const drive = accountRepo.insert({
      email: 'drive@gmail.com',
      displayName: 'Main Drive',
      totalSpace: 50000,
      usedSpace: 0,
      freeSpace: 50000,
      reservedBytes: 0,
      migrationLocked: false,
      status: 'AVAILABLE',
      encryptedCredentials: 'enc',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    providerFactory.registerMockProvider(drive.id, new InMemoryStorageProvider(50000));

    // Ensure virtual folder MyProject exists
    const projFolder = vfs.ensureDirectoryPath(null, ['MyProject']);
    expect(projFolder.name).toBe('MyProject');

    // Upload 2 files into MyProject
    const f1 = await transferService.uploadFile({
      name: 'README.md',
      parentId: projFolder.id,
      mimeType: 'text/markdown',
      size: 500,
      stream: Readable.from(Buffer.from('# Readme')),
    });

    const f2 = await transferService.uploadFile({
      name: 'package.json',
      parentId: projFolder.id,
      mimeType: 'application/json',
      size: 300,
      stream: Readable.from(Buffer.from('{}')),
    });

    const children = vfs.listChildren(projFolder.id);
    expect(children).toHaveLength(2);
    expect(children.map((c) => c.name).sort()).toEqual(['README.md', 'package.json']);
    expect(f1.file.parentId).toBe(projFolder.id);
    expect(f2.file.parentId).toBe(projFolder.id);
  });

  it('4 & 5. Nested and deep folder hierarchies (Project -> src -> api -> User.java)', async () => {
    const drive = accountRepo.insert({
      email: 'drive@gmail.com',
      displayName: 'Main Drive',
      totalSpace: 50000,
      usedSpace: 0,
      freeSpace: 50000,
      reservedBytes: 0,
      migrationLocked: false,
      status: 'AVAILABLE',
      encryptedCredentials: 'enc',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    providerFactory.registerMockProvider(drive.id, new InMemoryStorageProvider(50000));

    // Ensure nested path MyProject/src/api
    const apiFolder = vfs.ensureDirectoryPath(null, ['MyProject', 'src', 'api']);
    expect(apiFolder.name).toBe('api');

    const srcFolder = vfs.getNodeById(apiFolder.parentId!);
    expect(srcFolder?.name).toBe('src');

    const projectFolder = vfs.getNodeById(srcFolder!.parentId!);
    expect(projectFolder?.name).toBe('MyProject');
    expect(projectFolder?.parentId).toBeNull();

    // Upload User.java in api folder
    const userFile = await transferService.uploadFile({
      name: 'User.java',
      parentId: apiFolder.id,
      mimeType: 'text/x-java-source',
      size: 1500,
      stream: Readable.from(Buffer.from('public class User {}')),
    });

    expect(userFile.file.parentId).toBe(apiFolder.id);
    expect(vfs.getAbsolutePath(userFile.file.id)).toBe('/MyProject/src/api/User.java');
  });

  it('6 & 7 & 16. Three-Drive scenario: 30 GB folder placed across 3x 15 GB drives', () => {
    // Drive A = 15 GB, Drive B = 15 GB, Drive C = 15 GB
    const GB = 1024 * 1024 * 1024;
    accountRepo.insert({
      email: 'driveA@gmail.com',
      displayName: 'Drive A',
      totalSpace: 15 * GB,
      usedSpace: 0,
      freeSpace: 15 * GB,
      reservedBytes: 0,
      migrationLocked: false,
      status: 'AVAILABLE',
      encryptedCredentials: 'enc',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    accountRepo.insert({
      email: 'driveB@gmail.com',
      displayName: 'Drive B',
      totalSpace: 15 * GB,
      usedSpace: 0,
      freeSpace: 15 * GB,
      reservedBytes: 0,
      migrationLocked: false,
      status: 'AVAILABLE',
      encryptedCredentials: 'enc',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    accountRepo.insert({
      email: 'driveC@gmail.com',
      displayName: 'Drive C',
      totalSpace: 15 * GB,
      usedSpace: 0,
      freeSpace: 15 * GB,
      reservedBytes: 0,
      migrationLocked: false,
      status: 'AVAILABLE',
      encryptedCredentials: 'enc',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // Folder: 30 GB (movie1 = 12 GB, movie2 = 10 GB, movie3 = 8 GB)
    const plan = transferService.planFolderUpload({
      rootFolderName: 'MyMovies',
      parentId: null,
      files: [
        { relativePath: 'MyMovies/movie1.mkv', size: 12 * GB },
        { relativePath: 'MyMovies/movie2.mkv', size: 10 * GB },
        { relativePath: 'MyMovies/movie3.mkv', size: 8 * GB },
      ],
    });

    expect(plan.totalFiles).toBe(3);
    expect(plan.totalBytes).toBe(30 * GB);
    expect(plan.placements).toHaveLength(3);

    // Each file must be assigned to a drive and no single drive should exceed 15 GB
    const driveUsage = new Map<number, number>();
    for (const p of plan.placements) {
      const cur = driveUsage.get(p.destDriveId) || 0;
      driveUsage.set(p.destDriveId, cur + p.size);
    }

    for (const usage of driveUsage.values()) {
      expect(usage).toBeLessThanOrEqual(15 * GB);
    }
  });

  it('8 & 20. Rejects folder if any single file exceeds largest single drive capacity (No chunking)', () => {
    const GB = 1024 * 1024 * 1024;
    // 3 drives with 20 GB each (Total = 60 GB)
    for (let i = 1; i <= 3; i++) {
      accountRepo.insert({
        email: `drive${i}@gmail.com`,
        displayName: `Drive ${i}`,
        totalSpace: 20 * GB,
        usedSpace: 0,
        freeSpace: 20 * GB,
        reservedBytes: 0,
        migrationLocked: false,
        status: 'AVAILABLE',
        encryptedCredentials: 'enc',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }

    // Folder: total 40 GB, but file1 is 25 GB (cannot fit on any 20 GB drive)
    expect(() =>
      transferService.planFolderUpload({
        rootFolderName: 'HugeFolder',
        parentId: null,
        files: [
          { relativePath: 'file1.iso', size: 25 * GB },
          { relativePath: 'file2.iso', size: 10 * GB },
          { relativePath: 'file3.iso', size: 5 * GB },
        ],
      })
    ).toThrowError(/Reason: No available Drive can hold the/);
  });

  it('9. Rejects folder if total folder size exceeds total unified available storage', () => {
    const GB = 1024 * 1024 * 1024;
    accountRepo.insert({
      email: 'drive1@gmail.com',
      displayName: 'Drive 1',
      totalSpace: 10 * GB,
      usedSpace: 0,
      freeSpace: 10 * GB,
      reservedBytes: 0,
      migrationLocked: false,
      status: 'AVAILABLE',
      encryptedCredentials: 'enc',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    expect(() =>
      transferService.planFolderUpload({
        rootFolderName: 'BigFolder',
        parentId: null,
        files: [
          { relativePath: 'a.dat', size: 6 * GB },
          { relativePath: 'b.dat', size: 6 * GB },
        ],
      })
    ).toThrowError(/Unified available capacity/);
  });

  it('10. Accounts for reserved capacity and reduces usable space', () => {
    const GB = 1024 * 1024 * 1024;
    const drive = accountRepo.insert({
      email: 'drive1@gmail.com',
      displayName: 'Drive 1',
      totalSpace: 10 * GB,
      usedSpace: 2 * GB,
      freeSpace: 8 * GB,
      reservedBytes: 0,
      migrationLocked: false,
      status: 'AVAILABLE',
      encryptedCredentials: 'enc',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // Create operation and acquire active reservation of 5 GB
    opRepo.insert({
      id: 'OP-RES-1',
      operationType: 'UPLOAD',
      destDriveId: drive.id,
      requestedBytes: 5 * GB,
      status: 'RESERVED',
      createdAt: Date.now(),
    });
    resRepo.acquireAtomic(drive.id, 'OP-RES-1', 5 * GB);

    // Usable space is now 8 GB - 5 GB = 3 GB
    expect(() =>
      transferService.planFolderUpload({
        rootFolderName: 'ResFolder',
        parentId: null,
        files: [{ relativePath: 'test.mp4', size: 4 * GB }],
      })
    ).toThrowError(InsufficientCapacityError);
  });

  it('11 & 12. Excludes migration-locked and unavailable drives', () => {
    const GB = 1024 * 1024 * 1024;
    // Locked drive
    accountRepo.insert({
      email: 'locked@gmail.com',
      displayName: 'Locked Drive',
      totalSpace: 50 * GB,
      usedSpace: 0,
      freeSpace: 50 * GB,
      reservedBytes: 0,
      migrationLocked: true,
      status: 'AVAILABLE',
      encryptedCredentials: 'enc',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // Disconnected drive
    accountRepo.insert({
      email: 'offline@gmail.com',
      displayName: 'Offline Drive',
      totalSpace: 50 * GB,
      usedSpace: 0,
      freeSpace: 50 * GB,
      reservedBytes: 0,
      migrationLocked: false,
      status: 'DISCONNECTED',
      encryptedCredentials: 'enc',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    expect(() =>
      transferService.planFolderUpload({
        rootFolderName: 'Test',
        parentId: null,
        files: [{ relativePath: 'doc.pdf', size: 10 * GB }],
      })
    ).toThrowError(InsufficientCapacityError);
  });

  it('13 & 15. Intelligent retry and conflict handling (SKIP avoids duplicating files)', async () => {
    const drive = accountRepo.insert({
      email: 'drive1@gmail.com',
      displayName: 'Drive 1',
      totalSpace: 20000,
      usedSpace: 0,
      freeSpace: 20000,
      reservedBytes: 0,
      migrationLocked: false,
      status: 'AVAILABLE',
      encryptedCredentials: 'enc',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    providerFactory.registerMockProvider(drive.id, new InMemoryStorageProvider(20000));

    const folder = vfs.createFolder(null, 'RetryProject');

    // First upload
    const f1 = await transferService.uploadFile({
      name: 'config.json',
      parentId: folder.id,
      mimeType: 'application/json',
      size: 500,
      stream: Readable.from(Buffer.from('{"v":1}')),
    });

    // Retry upload with SKIP policy
    const retryResult = await transferService.uploadFile({
      name: 'config.json',
      parentId: folder.id,
      mimeType: 'application/json',
      size: 500,
      stream: Readable.from(Buffer.from('{"v":1}')),
      conflictAction: 'SKIP',
    });

    expect(retryResult.skipped).toBe(true);
    expect(retryResult.file.id).toBe(f1.file.id); // Same stable Smart File ID
    expect(vfs.listChildren(folder.id)).toHaveLength(1); // No duplicates
  });

  it('18, 19, 20. Verification of unified virtual hierarchy and physical locations mapping', async () => {
    const driveA = accountRepo.insert({
      email: 'a@gmail.com',
      displayName: 'Drive A',
      totalSpace: 20000,
      usedSpace: 0,
      freeSpace: 20000,
      reservedBytes: 0,
      migrationLocked: false,
      status: 'AVAILABLE',
      encryptedCredentials: 'enc',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const driveB = accountRepo.insert({
      email: 'b@gmail.com',
      displayName: 'Drive B',
      totalSpace: 20000,
      usedSpace: 0,
      freeSpace: 20000,
      reservedBytes: 0,
      migrationLocked: false,
      status: 'AVAILABLE',
      encryptedCredentials: 'enc',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    providerFactory.registerMockProvider(driveA.id, new InMemoryStorageProvider(20000));
    providerFactory.registerMockProvider(driveB.id, new InMemoryStorageProvider(20000));

    // Create Virtual Folder
    const rootFolder = vfs.ensureDirectoryPath(null, ['CompanyDocs', 'Financials']);

    const file1 = await transferService.uploadFile({
      name: 'report_2025.pdf',
      parentId: rootFolder.id,
      mimeType: 'application/pdf',
      size: 4000,
      stream: Readable.from(Buffer.from('report 2025')),
    });

    const file2 = await transferService.uploadFile({
      name: 'report_2026.pdf',
      parentId: rootFolder.id,
      mimeType: 'application/pdf',
      size: 4000,
      stream: Readable.from(Buffer.from('report 2026')),
    });

    // Verify virtual tree is unified under single hierarchy
    const tree = vfs.getTree(null);
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0].name).toBe('CompanyDocs');
    expect(tree.children[0].children[0].name).toBe('Financials');

    // Both files have stable Smart File IDs and parent points to Financials
    expect(file1.file.parentId).toBe(rootFolder.id);
    expect(file2.file.parentId).toBe(rootFolder.id);

    // Verify physical location records exist
    const loc1 = locationRepo.findActiveByFileId(file1.file.id);
    const loc2 = locationRepo.findActiveByFileId(file2.file.id);
    expect(loc1).toBeDefined();
    expect(loc2).toBeDefined();
    expect(loc1?.status).toBe('ACTIVE');
    expect(loc2?.status).toBe('ACTIVE');
  });
});
