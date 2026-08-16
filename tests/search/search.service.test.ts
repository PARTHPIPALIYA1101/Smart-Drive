import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabaseConnection, DatabaseConnection } from '../../src/persistence/db.js';
import { runMigrations } from '../../src/persistence/migrate.js';
import {
  FileRepository,
  GoogleAccountRepository,
  FileLocationRepository,
} from '../../src/persistence/repositories/index.js';
import { VirtualFilesystemService } from '../../src/domain/vfs/vfs.service.js';
import { SearchService } from '../../src/search/search.service.js';

describe('SearchService & File Properties Suite', () => {
  let conn: DatabaseConnection;
  let fileRepo: FileRepository;
  let locationRepo: FileLocationRepository;
  let accountRepo: GoogleAccountRepository;
  let vfs: VirtualFilesystemService;
  let searchService: SearchService;

  beforeEach(() => {
    conn = createDatabaseConnection(':memory:');
    runMigrations(conn);

    fileRepo = new FileRepository(conn.db);
    locationRepo = new FileLocationRepository(conn.db);
    accountRepo = new GoogleAccountRepository(conn.db);
    vfs = new VirtualFilesystemService(fileRepo);
    searchService = new SearchService(conn.db, vfs);
  });

  afterEach(() => {
    conn.close();
  });

  it('searches and filters by keyword, extension, and size range', () => {
    const now = Date.now();
    const drive = accountRepo.insert({
      email: 'search_drive@test.com',
      displayName: 'Search Drive',
      totalSpace: 50000,
      usedSpace: 0,
      freeSpace: 50000,
      reservedBytes: 0,
      migrationLocked: false,
      status: 'AVAILABLE',
      encryptedCredentials: 'enc',
      createdAt: now,
      updatedAt: now,
    });

    const folder = vfs.createFolder(null, 'Documents');

    const f1 = fileRepo.insert({
      name: 'financial_report_2026.pdf',
      parentId: folder.id,
      isFolder: false,
      mimeType: 'application/pdf',
      size: 5000,
      lifecycleStatus: 'ACTIVE',
      createdAt: now,
      updatedAt: now,
    });
    locationRepo.insert({
      fileId: f1.id,
      googleAccountId: drive.id,
      providerFileId: 'p-1',
      status: 'ACTIVE',
      size: 5000,
      mimeType: 'application/pdf',
      checksum: 'md5-1',
      checksumType: 'MD5',
      createdAt: now,
    });

    const f2 = fileRepo.insert({
      name: 'architecture_diagram.png',
      parentId: folder.id,
      isFolder: false,
      mimeType: 'image/png',
      size: 2000,
      lifecycleStatus: 'ACTIVE',
      createdAt: now,
      updatedAt: now,
    });
    locationRepo.insert({
      fileId: f2.id,
      googleAccountId: drive.id,
      providerFileId: 'p-2',
      status: 'ACTIVE',
      size: 2000,
      mimeType: 'image/png',
      createdAt: now,
    });

    // 1. Keyword search "report"
    const keywordResults = searchService.search({ query: 'report' });
    expect(keywordResults).toHaveLength(1);
    expect(keywordResults[0].name).toBe('financial_report_2026.pdf');
    expect(keywordResults[0].virtualPath).toBe('/Documents/financial_report_2026.pdf');

    // 2. Extension filter "pdf"
    const extResults = searchService.search({ extension: 'pdf' });
    expect(extResults).toHaveLength(1);
    expect(extResults[0].name).toBe('financial_report_2026.pdf');

    // 3. Size filter (minSize: 3000)
    const sizeResults = searchService.search({ minSize: 3000 });
    expect(sizeResults).toHaveLength(1);
    expect(sizeResults[0].name).toBe('financial_report_2026.pdf');

    // 4. Sorting descending by size
    const sortResults = searchService.search({ sortBy: 'size', sortOrder: 'desc' });
    expect(sortResults[0].size).toBeGreaterThanOrEqual(sortResults[1].size);
  });

  it('inspects full file properties with physical provider mapping', () => {
    const now = Date.now();
    const drive = accountRepo.insert({
      email: 'props_drive@test.com',
      displayName: 'Properties Drive',
      totalSpace: 20000,
      usedSpace: 1000,
      freeSpace: 19000,
      reservedBytes: 0,
      migrationLocked: false,
      status: 'AVAILABLE',
      encryptedCredentials: 'enc',
      createdAt: now,
      updatedAt: now,
    });

    const file = fileRepo.insert({
      name: 'notes.txt',
      parentId: null,
      isFolder: false,
      mimeType: 'text/plain',
      size: 350,
      lifecycleStatus: 'ACTIVE',
      createdAt: now,
      updatedAt: now,
    });

    locationRepo.insert({
      fileId: file.id,
      googleAccountId: drive.id,
      providerFileId: 'gdrive-address-100',
      status: 'ACTIVE',
      size: 350,
      mimeType: 'text/plain',
      checksum: 'e99a18c428cb38d5f260853678922e03',
      checksumType: 'MD5',
      createdAt: now,
    });

    const props = searchService.getFileProperties(file.id);
    expect(props.fileId).toBe(file.id);
    expect(props.name).toBe('notes.txt');
    expect(props.virtualPath).toBe('/notes.txt');
    expect(props.physicalLocation).toBeDefined();
    expect(props.physicalLocation?.googleAccountEmail).toBe('props_drive@test.com');
    expect(props.physicalLocation?.googleAccountName).toBe('Properties Drive');
    expect(props.physicalLocation?.providerFileId).toBe('gdrive-address-100');
    expect(props.physicalLocation?.checksum).toBe('e99a18c428cb38d5f260853678922e03');
  });
});
