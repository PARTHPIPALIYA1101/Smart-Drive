import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';
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
import { TransferService } from '../../src/domain/transfer/transfer.service.js';
import { StorageProviderFactory } from '../../src/providers/provider-factory.js';
import { InMemoryStorageProvider } from '../../src/providers/memory/in-memory-storage.provider.js';
import { InsufficientCapacityError, DriveUnavailableError } from '../../src/domain/errors.js';
import { DuplicateSiblingError } from '../../src/domain/vfs/vfs.service.js';

describe('TransferService & Direct Placement Pipeline Suite', () => {
  let conn: DatabaseConnection;
  let fileRepo: FileRepository;
  let locationRepo: FileLocationRepository;
  let accountRepo: GoogleAccountRepository;
  let opRepo: StorageOperationRepository;
  let resRepo: StorageReservationRepository;
  let capacityService: CapacityService;
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

  describe('Direct Placement (MAX_USABLE_FREE_SPACE)', () => {
    it('selects the drive with maximum usable free space for direct uploads', async () => {
      const now = Date.now();

      // Drive A: 5,000 bytes free
      const driveA = accountRepo.insert({
        email: 'driveA@gmail.com',
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

      // Drive B: 15,000 bytes free (should be selected)
      const driveB = accountRepo.insert({
        email: 'driveB@gmail.com',
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

      // Drive C: 10,000 bytes free
      const driveC = accountRepo.insert({
        email: 'driveC@gmail.com',
        displayName: 'Drive C',
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

      const memA = new InMemoryStorageProvider(10000);
      const memB = new InMemoryStorageProvider(20000);
      const memC = new InMemoryStorageProvider(15000);

      providerFactory.registerMockProvider(driveA.id, memA);
      providerFactory.registerMockProvider(driveB.id, memB);
      providerFactory.registerMockProvider(driveC.id, memC);

      const content = Buffer.from('8000 bytes of content here!'.padEnd(8000, '.'));
      const uploadResult = await transferService.uploadFile({
        name: 'app.zip',
        parentId: null,
        mimeType: 'application/zip',
        size: 8000,
        stream: Readable.from(content),
      });

      expect(uploadResult.file.id).toBeDefined();
      expect(uploadResult.file.name).toBe('app.zip');
      expect(uploadResult.location.googleAccountId).toBe(driveB.id); // Drive B selected!
      expect(uploadResult.location.status).toBe('ACTIVE');
      expect(uploadResult.operation.status).toBe('COMPLETED');

      // Check Drive B capacity updated in DB
      const updatedB = accountRepo.findById(driveB.id);
      expect(updatedB?.usedSpace).toBe(5000 + 8000);
      expect(updatedB?.freeSpace).toBe(20000 - 13000);
    });

    it('rejects direct upload when no single drive fits even if total unified space is sufficient', async () => {
      const now = Date.now();

      // Drive A: 5,000 free
      accountRepo.insert({
        email: 'driveA@gmail.com',
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

      // Drive B: 5,000 free (Total = 10,000 free, but largest single capacity = 5,000)
      accountRepo.insert({
        email: 'driveB@gmail.com',
        displayName: 'Drive B',
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

      // Attempting to upload 8,000 bytes
      await expect(
        transferService.uploadFile({
          name: 'big_video.mp4',
          parentId: null,
          mimeType: 'video/mp4',
          size: 8000,
          stream: Readable.from(Buffer.from(''.padEnd(8000, 'x'))),
        })
      ).rejects.toThrow(InsufficientCapacityError);
    });

    it('prevents uploading duplicate sibling filenames', async () => {
      const now = Date.now();
      const drive = accountRepo.insert({
        email: 'drive@gmail.com',
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

      providerFactory.registerMockProvider(drive.id, new InMemoryStorageProvider(10000));

      await transferService.uploadFile({
        name: 'notes.txt',
        parentId: null,
        mimeType: 'text/plain',
        size: 100,
        stream: Readable.from(Buffer.from('First notes')),
      });

      await expect(
        transferService.uploadFile({
          name: 'notes.txt',
          parentId: null,
          mimeType: 'text/plain',
          size: 200,
          stream: Readable.from(Buffer.from('Second notes')),
        })
      ).rejects.toThrow(DuplicateSiblingError);
    });

    it('rolls back cleanly if provider upload stream fails', async () => {
      const now = Date.now();
      const drive = accountRepo.insert({
        email: 'drive_fail@gmail.com',
        displayName: 'Fail Drive',
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

      const memProvider = new InMemoryStorageProvider(10000);
      memProvider.failNextUpload = true;
      providerFactory.registerMockProvider(drive.id, memProvider);

      await expect(
        transferService.uploadFile({
          name: 'fail.bin',
          parentId: null,
          mimeType: 'application/octet-stream',
          size: 500,
          stream: Readable.from(Buffer.from('broken upload stream')),
        })
      ).rejects.toThrow(/Simulated physical upload failure/);

      // Verify no active reservations left
      expect(resRepo.calculateActiveReservedBytes(drive.id)).toBe(0);

      // Verify no active file created
      expect(fileRepo.findActiveByParentId(null)).toHaveLength(0);
    });
  });

  describe('Download, Copy & Physical Deletion', () => {
    it('downloads binary stream and updates access timestamps', async () => {
      const now = Date.now();
      const drive = accountRepo.insert({
        email: 'dl_drive@gmail.com',
        displayName: 'DL Drive',
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

      providerFactory.registerMockProvider(drive.id, new InMemoryStorageProvider(10000));

      const payload = Buffer.from('Binary content to download');
      const upload = await transferService.uploadFile({
        name: 'download_me.txt',
        parentId: null,
        mimeType: 'text/plain',
        size: payload.length,
        stream: Readable.from(payload),
      });

      const downloadResult = await transferService.downloadFile(upload.file.id);
      expect(downloadResult.mimeType).toBe('text/plain');

      const chunks: Buffer[] = [];
      for await (const chunk of downloadResult.stream) {
        chunks.push(Buffer.from(chunk));
      }
      expect(Buffer.concat(chunks).toString()).toBe('Binary content to download');

      const updatedFile = fileRepo.findById(upload.file.id);
      expect(updatedFile?.lastDownloadedAt).toBeDefined();
    });

    it('rejects download when the storing physical drive is UNAVAILABLE', async () => {
      const now = Date.now();
      const drive = accountRepo.insert({
        email: 'unavail_drive@gmail.com',
        displayName: 'Unavail Drive',
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

      providerFactory.registerMockProvider(drive.id, new InMemoryStorageProvider(10000));

      const upload = await transferService.uploadFile({
        name: 'locked_file.txt',
        parentId: null,
        mimeType: 'text/plain',
        size: 50,
        stream: Readable.from(Buffer.from('hello')),
      });

      // Mark Drive UNAVAILABLE
      accountRepo.updateStatus(drive.id, 'UNAVAILABLE');

      await expect(transferService.downloadFile(upload.file.id)).rejects.toThrow(
        DriveUnavailableError
      );
    });

    it('copies file to a new virtual location', async () => {
      const now = Date.now();
      const drive = accountRepo.insert({
        email: 'copy_drive@gmail.com',
        displayName: 'Copy Drive',
        totalSpace: 20000,
        usedSpace: 0,
        freeSpace: 20000,
        reservedBytes: 0,
        migrationLocked: false,
        status: 'AVAILABLE',
        encryptedCredentials: 'enc',
        createdAt: now,
        updatedAt: now,
      });

      providerFactory.registerMockProvider(drive.id, new InMemoryStorageProvider(20000));

      const upload = await transferService.uploadFile({
        name: 'original.txt',
        parentId: null,
        mimeType: 'text/plain',
        size: 100,
        stream: Readable.from(Buffer.from('original data')),
      });

      const copyResult = await transferService.copyFile({
        fileId: upload.file.id,
        targetParentId: null,
        newName: 'clone.txt',
      });

      expect(copyResult.file.id).not.toBe(upload.file.id);
      expect(copyResult.file.name).toBe('clone.txt');

      const allFiles = fileRepo.findActiveByParentId(null);
      expect(allFiles).toHaveLength(2);
    });

    it('deletes physical file from provider and clears database location', async () => {
      const now = Date.now();
      const drive = accountRepo.insert({
        email: 'del_drive@gmail.com',
        displayName: 'Del Drive',
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

      const memProvider = new InMemoryStorageProvider(10000);
      providerFactory.registerMockProvider(drive.id, memProvider);

      const upload = await transferService.uploadFile({
        name: 'delete_me.txt',
        parentId: null,
        mimeType: 'text/plain',
        size: 500,
        stream: Readable.from(Buffer.from('to delete')),
      });

      const deleted = await transferService.deleteFilePhysically(upload.file.id);
      expect(deleted).toBe(true);

      // Verify file removed from DB
      expect(fileRepo.findById(upload.file.id)).toBeUndefined();
      expect(locationRepo.findActiveByFileId(upload.file.id)).toBeUndefined();

      // Verify drive quota released
      const updatedDrive = accountRepo.findById(drive.id);
      expect(updatedDrive?.usedSpace).toBe(0);
    });
  });
});
