import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabaseConnection, DatabaseConnection } from '../../src/persistence/db.js';
import { runMigrations } from '../../src/persistence/migrate.js';
import {
  FileRepository,
  GoogleAccountRepository,
  FileLocationRepository,
} from '../../src/persistence/repositories/index.js';
import { VirtualFilesystemService, DuplicateSiblingError } from '../../src/domain/vfs/vfs.service.js';

describe('VirtualFilesystem Trash Bin Full Lifecycle Suite', () => {
  let conn: DatabaseConnection;
  let fileRepo: FileRepository;
  let locationRepo: FileLocationRepository;
  let accountRepo: GoogleAccountRepository;
  let vfs: VirtualFilesystemService;

  beforeEach(() => {
    conn = createDatabaseConnection(':memory:');
    runMigrations(conn);

    fileRepo = new FileRepository(conn.db);
    locationRepo = new FileLocationRepository(conn.db);
    accountRepo = new GoogleAccountRepository(conn.db);
    vfs = new VirtualFilesystemService(fileRepo);
  });

  afterEach(() => {
    conn.close();
  });

  it('trashes and restores a single file while keeping physical locations unchanged', () => {
    const now = Date.now();
    const drive = accountRepo.insert({
      email: 'user@gmail.com',
      displayName: 'Drive 1',
      totalSpace: 10000,
      usedSpace: 1000,
      freeSpace: 9000,
      reservedBytes: 0,
      migrationLocked: false,
      status: 'AVAILABLE',
      encryptedCredentials: 'enc',
      createdAt: now,
      updatedAt: now,
    });

    const file = fileRepo.insert({
      name: 'report.pdf',
      parentId: null,
      isFolder: false,
      mimeType: 'application/pdf',
      size: 1000,
      lifecycleStatus: 'ACTIVE',
      createdAt: now,
      updatedAt: now,
    });

    const loc = locationRepo.insert({
      fileId: file.id,
      googleAccountId: drive.id,
      providerFileId: 'p-report-1',
      status: 'ACTIVE',
      size: 1000,
      mimeType: 'application/pdf',
      createdAt: now,
    });

    // 1. Trash File
    const trashed = vfs.trashNode(file.id);
    expect(trashed.lifecycleStatus).toBe('TRASHED');
    expect(trashed.trashedAt).toBeGreaterThan(0);

    // Normal listing must exclude trashed file
    const rootChildren = vfs.listChildren(null);
    expect(rootChildren).toHaveLength(0);

    // Physical location must remain untouched
    const activeLoc = locationRepo.findActiveByFileId(file.id);
    expect(activeLoc).toBeDefined();
    expect(activeLoc?.id).toBe(loc.id);
    expect(activeLoc?.providerFileId).toBe('p-report-1');

    // Trash listing must contain the file
    const trashList = vfs.listTrash();
    expect(trashList).toHaveLength(1);
    expect(trashList[0].id).toBe(file.id);

    // 2. Restore File
    const restored = vfs.restoreNode(file.id);
    expect(restored.lifecycleStatus).toBe('ACTIVE');
    expect(restored.trashedAt).toBeNull();

    // Normal listing must show restored file again
    const restoredChildren = vfs.listChildren(null);
    expect(restoredChildren).toHaveLength(1);
    expect(restoredChildren[0].id).toBe(file.id);
  });

  it('recursively cascades trash and restore across nested folders and files', () => {
    const parentFolder = vfs.createFolder(null, 'Work');
    const subFolder = vfs.createFolder(parentFolder.id, 'Projects');

    const f1 = fileRepo.insert({
      name: 'spec.md',
      parentId: subFolder.id,
      isFolder: false,
      mimeType: 'text/markdown',
      size: 500,
      lifecycleStatus: 'ACTIVE',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const f2 = fileRepo.insert({
      name: 'notes.txt',
      parentId: parentFolder.id,
      isFolder: false,
      mimeType: 'text/plain',
      size: 200,
      lifecycleStatus: 'ACTIVE',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // Trash top parent folder
    vfs.trashNode(parentFolder.id);

    // Verify all descendants are marked TRASHED
    expect(fileRepo.findById(parentFolder.id)?.lifecycleStatus).toBe('TRASHED');
    expect(fileRepo.findById(subFolder.id)?.lifecycleStatus).toBe('TRASHED');
    expect(fileRepo.findById(f1.id)?.lifecycleStatus).toBe('TRASHED');
    expect(fileRepo.findById(f2.id)?.lifecycleStatus).toBe('TRASHED');

    // Normal listing is empty
    expect(vfs.listChildren(null)).toHaveLength(0);
    expect(vfs.listChildren(parentFolder.id)).toHaveLength(0);

    // Restore top parent folder -> all descendants restored
    vfs.restoreNode(parentFolder.id);
    expect(fileRepo.findById(parentFolder.id)?.lifecycleStatus).toBe('ACTIVE');
    expect(fileRepo.findById(subFolder.id)?.lifecycleStatus).toBe('ACTIVE');
    expect(fileRepo.findById(f1.id)?.lifecycleStatus).toBe('ACTIVE');
    expect(fileRepo.findById(f2.id)?.lifecycleStatus).toBe('ACTIVE');
  });

  it('safely re-parents restored file to root if its original parent folder is trashed/deleted', () => {
    const folder = vfs.createFolder(null, 'Archive');
    const file = fileRepo.insert({
      name: 'data.csv',
      parentId: folder.id,
      isFolder: false,
      mimeType: 'text/csv',
      size: 300,
      lifecycleStatus: 'ACTIVE',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // Trash both
    vfs.trashNode(folder.id);

    // Restore ONLY the child file
    const restoredFile = vfs.restoreNode(file.id);
    expect(restoredFile.lifecycleStatus).toBe('ACTIVE');
    expect(restoredFile.parentId).toBeNull(); // Safely fell back to root!

    // Appears at root listing
    const rootChildren = vfs.listChildren(null);
    expect(rootChildren.some((c) => c.id === file.id)).toBe(true);
  });

  it('throws DuplicateSiblingError when restored item conflicts with an active sibling', () => {
    const file1 = fileRepo.insert({
      name: 'resume.docx',
      parentId: null,
      isFolder: false,
      mimeType: 'application/docx',
      size: 400,
      lifecycleStatus: 'ACTIVE',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // Trash file1
    vfs.trashNode(file1.id);

    // Create a new file with same name at root
    fileRepo.insert({
      name: 'resume.docx',
      parentId: null,
      isFolder: false,
      mimeType: 'application/docx',
      size: 600,
      lifecycleStatus: 'ACTIVE',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // Attempting to restore file1 must throw DuplicateSiblingError
    expect(() => {
      vfs.restoreNode(file1.id);
    }).toThrow(DuplicateSiblingError);
  });

  it('empties trash cleanly by purging all trashed virtual records', () => {
    const f1 = fileRepo.insert({
      name: 'temp1.txt',
      parentId: null,
      isFolder: false,
      mimeType: 'text/plain',
      size: 100,
      lifecycleStatus: 'ACTIVE',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const f2 = fileRepo.insert({
      name: 'temp2.txt',
      parentId: null,
      isFolder: false,
      mimeType: 'text/plain',
      size: 100,
      lifecycleStatus: 'ACTIVE',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    vfs.trashNode(f1.id);
    vfs.trashNode(f2.id);

    expect(vfs.listTrash()).toHaveLength(2);

    const deletedCount = vfs.emptyTrash();
    expect(deletedCount).toBe(2);

    expect(vfs.listTrash()).toHaveLength(0);
    expect(fileRepo.findById(f1.id)).toBeUndefined();
    expect(fileRepo.findById(f2.id)).toBeUndefined();
  });

  it('handles repeated and idempotent trash calls without errors', () => {
    const file = fileRepo.insert({
      name: 'idempotent.txt',
      parentId: null,
      isFolder: false,
      mimeType: 'text/plain',
      size: 100,
      lifecycleStatus: 'ACTIVE',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const res1 = vfs.trashNode(file.id);
    expect(res1.lifecycleStatus).toBe('TRASHED');

    // Calling trashNode again on already-trashed file returns cleanly
    const res2 = vfs.trashNode(file.id);
    expect(res2.lifecycleStatus).toBe('TRASHED');
    expect(vfs.listTrash()).toHaveLength(1);
  });

  it('permanently deletes recursive folder structure and cleans up all descendants', async () => {
    const { TransferService } = await import('../../src/domain/transfer/transfer.service.js');
    const { StorageOperationRepository } = await import('../../src/persistence/repositories/storage-operation.repository.js');
    const { StorageReservationRepository } = await import('../../src/persistence/repositories/storage-reservation.repository.js');
    const { CapacityService } = await import('../../src/domain/capacity/capacity.service.js');
    const { StorageProviderFactory } = await import('../../src/providers/provider-factory.js');
    const { InMemoryStorageProvider } = await import('../../src/providers/memory/in-memory-storage.provider.js');

    const opRepo = new StorageOperationRepository(conn.db);
    const resRepo = new StorageReservationRepository(conn.db);
    const capacityService = new CapacityService(accountRepo, resRepo);
    const providerFactory = new StorageProviderFactory();

    const drive = accountRepo.insert({
      email: 'user2@gmail.com',
      displayName: 'Drive 2',
      totalSpace: 20000,
      usedSpace: 5000,
      freeSpace: 15000,
      reservedBytes: 0,
      migrationLocked: false,
      status: 'AVAILABLE',
      encryptedCredentials: 'enc',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    providerFactory.registerMockProvider(drive.id, new InMemoryStorageProvider(20000));

    const transferService = new TransferService(
      fileRepo,
      locationRepo,
      accountRepo,
      opRepo,
      resRepo,
      capacityService,
      providerFactory
    );

    const rootFolder = vfs.createFolder(null, 'NestedProject');
    const subFolder = vfs.createFolder(rootFolder.id, 'SubDir');

    const file1 = fileRepo.insert({
      name: 'doc1.pdf',
      parentId: rootFolder.id,
      isFolder: false,
      mimeType: 'application/pdf',
      size: 2000,
      lifecycleStatus: 'ACTIVE',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const file2 = fileRepo.insert({
      name: 'doc2.pdf',
      parentId: subFolder.id,
      isFolder: false,
      mimeType: 'application/pdf',
      size: 3000,
      lifecycleStatus: 'ACTIVE',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    locationRepo.insert({
      fileId: file1.id,
      googleAccountId: drive.id,
      providerFileId: 'p-doc1',
      status: 'ACTIVE',
      size: 2000,
      mimeType: 'application/pdf',
      createdAt: Date.now(),
    });

    locationRepo.insert({
      fileId: file2.id,
      googleAccountId: drive.id,
      providerFileId: 'p-doc2',
      status: 'ACTIVE',
      size: 3000,
      mimeType: 'application/pdf',
      createdAt: Date.now(),
    });

    // Permanently delete rootFolder
    const deleted = await transferService.deleteFilePhysically(rootFolder.id);
    expect(deleted).toBe(true);

    // All records should be permanently deleted from DB
    expect(fileRepo.findById(rootFolder.id)).toBeUndefined();
    expect(fileRepo.findById(subFolder.id)).toBeUndefined();
    expect(fileRepo.findById(file1.id)).toBeUndefined();
    expect(fileRepo.findById(file2.id)).toBeUndefined();

    // Locations should be wiped
    expect(locationRepo.findAllByFileId(file1.id)).toHaveLength(0);
    expect(locationRepo.findAllByFileId(file2.id)).toHaveLength(0);

    // Calling deleteFilePhysically again on deleted id is idempotent
    expect(await transferService.deleteFilePhysically(rootFolder.id)).toBe(true);
  });

  it('emptyTrashPhysically deletes all trashed items and updates account used space', async () => {
    const { TransferService } = await import('../../src/domain/transfer/transfer.service.js');
    const { StorageOperationRepository } = await import('../../src/persistence/repositories/storage-operation.repository.js');
    const { StorageReservationRepository } = await import('../../src/persistence/repositories/storage-reservation.repository.js');
    const { CapacityService } = await import('../../src/domain/capacity/capacity.service.js');
    const { StorageProviderFactory } = await import('../../src/providers/provider-factory.js');
    const { InMemoryStorageProvider } = await import('../../src/providers/memory/in-memory-storage.provider.js');

    const opRepo = new StorageOperationRepository(conn.db);
    const resRepo = new StorageReservationRepository(conn.db);
    const capacityService = new CapacityService(accountRepo, resRepo);
    const providerFactory = new StorageProviderFactory();

    const drive = accountRepo.insert({
      email: 'user3@gmail.com',
      displayName: 'Drive 3',
      totalSpace: 20000,
      usedSpace: 5000,
      freeSpace: 15000,
      reservedBytes: 0,
      migrationLocked: false,
      status: 'AVAILABLE',
      encryptedCredentials: 'enc',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    providerFactory.registerMockProvider(drive.id, new InMemoryStorageProvider(20000));

    const transferService = new TransferService(
      fileRepo,
      locationRepo,
      accountRepo,
      opRepo,
      resRepo,
      capacityService,
      providerFactory
    );

    const f1 = fileRepo.insert({
      name: 'trash1.txt',
      parentId: null,
      isFolder: false,
      mimeType: 'text/plain',
      size: 1000,
      lifecycleStatus: 'TRASHED',
      trashedAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    locationRepo.insert({
      fileId: f1.id,
      googleAccountId: drive.id,
      providerFileId: 'p-trash1',
      status: 'ACTIVE',
      size: 1000,
      mimeType: 'text/plain',
      createdAt: Date.now(),
    });

    const purgedCount = await transferService.emptyTrashPhysically();
    expect(purgedCount).toBe(1);
    expect(fileRepo.findById(f1.id)).toBeUndefined();
    expect(accountRepo.findById(drive.id)?.usedSpace).toBe(4000); // 5000 - 1000 = 4000
  });
});
