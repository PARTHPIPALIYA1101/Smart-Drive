import { eq, and, like, gte, lte, asc, desc, sql } from 'drizzle-orm';
import { AppDatabase } from '../persistence/db.js';
import { files } from '../persistence/schema/files.js';
import { fileLocations } from '../persistence/schema/file-locations.js';
import { googleAccounts } from '../persistence/schema/google-accounts.js';
import { VirtualFilesystemService } from '../domain/vfs/vfs.service.js';
import { SearchQuery, SearchResultItem, FileProperties } from './search.types.js';
import { EntityNotFoundError } from '../domain/errors.js';

export class SearchService {
  constructor(
    private db: AppDatabase,
    private vfsService: VirtualFilesystemService
  ) {}

  /**
   * Performs unified metadata search and filtering across the virtual filesystem.
   */
  search(query: SearchQuery): SearchResultItem[] {
    const conditions = [];

    // Filter by query keyword in filename
    if (query.query && query.query.trim().length > 0) {
      conditions.push(like(files.name, `%${query.query.trim()}%`));
    }

    // Filter by parent folder
    if (query.parentId !== undefined) {
      if (query.parentId === null) {
        conditions.push(sql`${files.parentId} IS NULL`);
      } else {
        conditions.push(eq(files.parentId, query.parentId));
      }
    }

    // Filter by isFolder
    if (query.isFolder !== undefined) {
      conditions.push(eq(files.isFolder, query.isFolder));
    }

    // Filter by exact MIME type
    if (query.mimeType) {
      conditions.push(eq(files.mimeType, query.mimeType));
    }

    // Filter by extension (e.g. "pdf", ".zip")
    if (query.extension) {
      const ext = query.extension.startsWith('.') ? query.extension : `.${query.extension}`;
      conditions.push(like(files.name, `%${ext}`));
    }

    // Size range filters
    if (query.minSize !== undefined) {
      conditions.push(gte(files.size, query.minSize));
    }
    if (query.maxSize !== undefined) {
      conditions.push(lte(files.size, query.maxSize));
    }

    // Lifecycle status filter (default ACTIVE unless specified)
    const status = query.lifecycleStatus || 'ACTIVE';
    conditions.push(eq(files.lifecycleStatus, status));

    // Dynamic sorting
    let orderByClause;
    const isDesc = (query.sortOrder || 'asc') === 'desc';

    switch (query.sortBy) {
      case 'size':
        orderByClause = isDesc ? desc(files.size) : asc(files.size);
        break;
      case 'created_at':
        orderByClause = isDesc ? desc(files.createdAt) : asc(files.createdAt);
        break;
      case 'updated_at':
        orderByClause = isDesc ? desc(files.updatedAt) : asc(files.updatedAt);
        break;
      case 'name':
      default:
        orderByClause = isDesc ? desc(files.name) : asc(files.name);
        break;
    }

    const queryBuilder = this.db
      .select({
        id: files.id,
        name: files.name,
        parentId: files.parentId,
        isFolder: files.isFolder,
        mimeType: files.mimeType,
        size: files.size,
        lifecycleStatus: files.lifecycleStatus,
        createdAt: files.createdAt,
        updatedAt: files.updatedAt,
        googleAccountId: fileLocations.googleAccountId,
        googleAccountName: googleAccounts.displayName,
        checksum: fileLocations.checksum,
      })
      .from(files)
      .leftJoin(
        fileLocations,
        and(eq(files.id, fileLocations.fileId), eq(fileLocations.status, 'ACTIVE'))
      )
      .leftJoin(googleAccounts, eq(fileLocations.googleAccountId, googleAccounts.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(orderByClause)
      .limit(query.limit || 100)
      .offset(query.offset || 0);

    const rows = queryBuilder.all();

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      virtualPath: this.vfsService.getAbsolutePath(row.id),
      isFolder: row.isFolder,
      mimeType: row.mimeType,
      size: row.size,
      lifecycleStatus: row.lifecycleStatus,
      googleAccountId: row.googleAccountId ?? undefined,
      googleAccountName: row.googleAccountName ?? undefined,
      checksum: row.checksum ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  }

  /**
   * Retrieves complete file properties including virtual hierarchy and physical location mappings.
   */
  getFileProperties(fileId: number): FileProperties {
    const row = this.db
      .select({
        file: files,
        location: fileLocations,
        account: googleAccounts,
      })
      .from(files)
      .leftJoin(
        fileLocations,
        and(eq(files.id, fileLocations.fileId), eq(fileLocations.status, 'ACTIVE'))
      )
      .leftJoin(googleAccounts, eq(fileLocations.googleAccountId, googleAccounts.id))
      .where(eq(files.id, fileId))
      .get();

    if (!row) {
      throw new EntityNotFoundError('File', fileId);
    }

    const virtualPath = this.vfsService.getAbsolutePath(fileId);

    return {
      fileId: row.file.id,
      name: row.file.name,
      virtualPath,
      isFolder: row.file.isFolder,
      mimeType: row.file.mimeType,
      size: row.file.size,
      lifecycleStatus: row.file.lifecycleStatus,
      createdAt: row.file.createdAt,
      updatedAt: row.file.updatedAt,
      lastAccessedAt: row.file.lastAccessedAt,
      lastDownloadedAt: row.file.lastDownloadedAt,
      trashedAt: row.file.trashedAt,
      physicalLocation: row.location && row.account
        ? {
            locationId: row.location.id,
            googleAccountId: row.account.id,
            googleAccountEmail: row.account.email,
            googleAccountName: row.account.displayName,
            providerFileId: row.location.providerFileId,
            status: row.location.status,
            checksum: row.location.checksum,
            checksumType: row.location.checksumType,
          }
        : undefined,
    };
  }
}
