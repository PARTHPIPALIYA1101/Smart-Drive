import { FileRepository } from '../../persistence/repositories/file.repository.js';
import { FileLocationRepository } from '../../persistence/repositories/file-location.repository.js';
import { GoogleAccountRepository } from '../../persistence/repositories/google-account.repository.js';
import { IProviderFactory } from '../../providers/provider-factory.js';
import { AppDatabase } from '../../persistence/db.js';
import { files } from '../../persistence/schema/files.js';
import { fileLocations } from '../../persistence/schema/file-locations.js';
import { eq, and, isNull } from 'drizzle-orm';

export interface ImportResult {
  accountId: number;
  accountName: string;
  importedCount: number;
  skippedCount: number;
}

export class DriveImportService {
  constructor(
    private db: AppDatabase,
    private fileRepo: FileRepository,
    private locationRepo: FileLocationRepository,
    private accountRepo: GoogleAccountRepository,
    private providerFactory: IProviderFactory
  ) {}

  /**
   * Scans an external Google Drive account and imports any files not yet present in the VFS.
   */
  async importAccountFiles(accountId: number): Promise<ImportResult> {
    const account = this.accountRepo.findById(accountId);
    if (!account) {
      throw new Error(`Google Account ${accountId} not found`);
    }

    const provider = this.providerFactory.getProvider(accountId);
    if (!provider.listFiles) {
      return { accountId, accountName: account.displayName, importedCount: 0, skippedCount: 0 };
    }

    const remoteFiles = await provider.listFiles();
    let importedCount = 0;
    let skippedCount = 0;

    for (const remote of remoteFiles) {
      // Check if providerFileId is already registered in Smart Drive
      const existingLocation = this.db
        .select()
        .from(fileLocations)
        .where(eq(fileLocations.providerFileId, remote.providerFileId))
        .get();

      if (existingLocation) {
        skippedCount++;
        continue;
      }

      // Generate non-colliding name in root if needed
      let filename = remote.filename || 'Untitled';
      let suffix = 1;
      while (
        this.db
          .select()
          .from(files)
          .where(and(eq(files.name, filename), isNull(files.parentId), eq(files.lifecycleStatus, 'ACTIVE')))
          .get()
      ) {
        const dotIdx = remote.filename.lastIndexOf('.');
        if (dotIdx > 0) {
          filename = `${remote.filename.substring(0, dotIdx)} (${suffix})${remote.filename.substring(dotIdx)}`;
        } else {
          filename = `${remote.filename} (${suffix})`;
        }
        suffix++;
      }

      const now = Date.now();
      // Create VFS record and file location
      const newFile = this.fileRepo.insert({
        name: filename,
        parentId: null,
        isFolder: false,
        mimeType: remote.mimeType || 'application/octet-stream',
        size: remote.size || 0,
        lifecycleStatus: 'ACTIVE',
        createdAt: now,
        updatedAt: now,
      });

      this.locationRepo.insert({
        fileId: newFile.id,
        googleAccountId: accountId,
        providerFileId: remote.providerFileId,
        size: remote.size || 0,
        status: 'ACTIVE',
        checksum: remote.checksum,
        checksumType: remote.checksumType || 'MD5',
        createdAt: now,
      });

      importedCount++;
    }

    return {
      accountId,
      accountName: account.displayName,
      importedCount,
      skippedCount,
    };
  }

  /**
   * Scans all connected Google Drive accounts and imports untracked files into Smart Drive.
   */
  async importAllAccounts(): Promise<ImportResult[]> {
    const accounts = this.accountRepo.listAll();
    const results: ImportResult[] = [];

    for (const acc of accounts) {
      try {
        const res = await this.importAccountFiles(acc.id);
        results.push(res);
      } catch (err) {
        console.error(`Failed to import files from account ${acc.id}:`, err);
      }
    }

    return results;
  }
}
