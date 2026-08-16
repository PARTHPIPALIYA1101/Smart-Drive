import { eq } from 'drizzle-orm';
import { AppDatabase } from '../db.js';
import { fileMigrations, FileMigrationInsert, FileMigrationSelect } from '../schema/file-migrations.js';
import { MigrationStatus } from '../../domain/types.js';

export class FileMigrationRepository {
  constructor(private db: AppDatabase) {}

  insert(data: FileMigrationInsert): FileMigrationSelect {
    return this.db.insert(fileMigrations).values(data).returning().get();
  }

  findById(id: number): FileMigrationSelect | undefined {
    return this.db.select().from(fileMigrations).where(eq(fileMigrations.id, id)).get();
  }

  findByOperationId(operationId: string): FileMigrationSelect | undefined {
    return this.db
      .select()
      .from(fileMigrations)
      .where(eq(fileMigrations.operationId, operationId))
      .get();
  }

  findByFileId(fileId: number): FileMigrationSelect[] {
    return this.db.select().from(fileMigrations).where(eq(fileMigrations.fileId, fileId)).all();
  }

  updateStatus(
    id: number,
    status: MigrationStatus,
    bytesTransferred?: number,
    destProviderFileId?: string
  ): FileMigrationSelect | undefined {
    const now = Date.now();
    const updateData: Partial<FileMigrationInsert> = { status };

    if (bytesTransferred !== undefined) {
      updateData.bytesTransferred = bytesTransferred;
    }
    if (destProviderFileId !== undefined) {
      updateData.destProviderFileId = destProviderFileId;
    }
    if (status === 'COMPLETED' || status === 'FAILED' || status === 'ABORTED') {
      updateData.completedAt = now;
    }

    return this.db
      .update(fileMigrations)
      .set(updateData)
      .where(eq(fileMigrations.id, id))
      .returning()
      .get();
  }
}
