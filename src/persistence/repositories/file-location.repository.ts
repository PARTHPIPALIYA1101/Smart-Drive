import { eq, and } from 'drizzle-orm';
import { AppDatabase } from '../db.js';
import { fileLocations, FileLocationInsert, FileLocationSelect } from '../schema/file-locations.js';
import { files } from '../schema/files.js';
import { LocationStatus } from '../../domain/types.js';

export class FileLocationRepository {
  constructor(private db: AppDatabase) {}

  insert(data: FileLocationInsert): FileLocationSelect {
    return this.db.insert(fileLocations).values(data).returning().get();
  }

  findById(id: number): FileLocationSelect | undefined {
    return this.db.select().from(fileLocations).where(eq(fileLocations.id, id)).get();
  }

  findActiveByFileId(fileId: number): FileLocationSelect | undefined {
    return this.db
      .select()
      .from(fileLocations)
      .where(and(eq(fileLocations.fileId, fileId), eq(fileLocations.status, 'ACTIVE')))
      .get();
  }

  findAllByFileId(fileId: number): FileLocationSelect[] {
    return this.db.select().from(fileLocations).where(eq(fileLocations.fileId, fileId)).all();
  }

  updateStatus(id: number, status: LocationStatus): FileLocationSelect | undefined {
    return this.db
      .update(fileLocations)
      .set({ status })
      .where(eq(fileLocations.id, id))
      .returning()
      .get();
  }

  updateProviderMetadata(
    id: number,
    providerFileId: string,
    checksum?: string | null,
    checksumType?: 'MD5' | 'SHA256' | 'PROVIDER_HASH' | 'NONE' | null
  ): FileLocationSelect | undefined {
    return this.db
      .update(fileLocations)
      .set({
        providerFileId,
        checksum,
        checksumType,
      })
      .where(eq(fileLocations.id, id))
      .returning()
      .get();
  }

  /**
   * Microsecond DB transaction that atomically switches active location:
   * Sets new location -> ACTIVE, old location -> OLD, and touches files.updated_at.
   */
  switchActiveLocation(
    fileId: number,
    newActiveLocationId: number,
    oldActiveLocationId: number
  ): { newLocation: FileLocationSelect; oldLocation: FileLocationSelect } {
    return this.db.transaction((tx) => {
      const now = Date.now();

      const newLoc = tx
        .update(fileLocations)
        .set({ status: 'ACTIVE', migratedAt: now })
        .where(and(eq(fileLocations.id, newActiveLocationId), eq(fileLocations.fileId, fileId)))
        .returning()
        .get();

      if (!newLoc) {
        throw new Error(`New location ${newActiveLocationId} not found for file ${fileId}`);
      }

      const oldLoc = tx
        .update(fileLocations)
        .set({ status: 'OLD' })
        .where(and(eq(fileLocations.id, oldActiveLocationId), eq(fileLocations.fileId, fileId)))
        .returning()
        .get();

      if (!oldLoc) {
        throw new Error(`Old location ${oldActiveLocationId} not found for file ${fileId}`);
      }

      tx.update(files)
        .set({ updatedAt: now })
        .where(eq(files.id, fileId))
        .run();

      return { newLocation: newLoc, oldLocation: oldLoc };
    });
  }

  delete(id: number): boolean {
    const result = this.db.delete(fileLocations).where(eq(fileLocations.id, id)).run();
    return result.changes > 0;
  }
}
