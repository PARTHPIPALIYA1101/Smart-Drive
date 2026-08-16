import { eq, inArray, desc } from 'drizzle-orm';
import { AppDatabase } from '../db.js';
import { storageOperations, StorageOperationInsert, StorageOperationSelect } from '../schema/storage-operations.js';
import { OperationStatus } from '../../domain/types.js';

export class StorageOperationRepository {
  constructor(private db: AppDatabase) {}

  insert(data: StorageOperationInsert): StorageOperationSelect {
    return this.db.insert(storageOperations).values(data).returning().get();
  }

  findById(id: string): StorageOperationSelect | undefined {
    return this.db.select().from(storageOperations).where(eq(storageOperations.id, id)).get();
  }

  findIncompleteOperations(): StorageOperationSelect[] {
    const incompleteStatuses: OperationStatus[] = [
      'PENDING',
      'RESERVED',
      'EXECUTING',
      'VERIFYING',
      'SWITCHING',
      'RECOVERY_REQUIRED',
    ];
    return this.db
      .select()
      .from(storageOperations)
      .where(inArray(storageOperations.status, incompleteStatuses))
      .all();
  }

  updateStatus(
    id: string,
    status: OperationStatus,
    errorCode?: string | null,
    errorMessage?: string | null
  ): StorageOperationSelect | undefined {
    const now = Date.now();
    const updateData: Partial<StorageOperationInsert> = { status };

    if (status === 'EXECUTING') {
      updateData.startedAt = now;
    }
    if (status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED') {
      updateData.completedAt = now;
    }
    if (errorCode !== undefined) {
      updateData.errorCode = errorCode;
    }
    if (errorMessage !== undefined) {
      updateData.errorMessage = errorMessage;
    }

    return this.db
      .update(storageOperations)
      .set(updateData)
      .where(eq(storageOperations.id, id))
      .returning()
      .get();
  }

  updatePlanContext(id: string, planContext: string): StorageOperationSelect | undefined {
    return this.db
      .update(storageOperations)
      .set({ planContext })
      .where(eq(storageOperations.id, id))
      .returning()
      .get();
  }

  listRecent(limit = 50): StorageOperationSelect[] {
    return this.db
      .select()
      .from(storageOperations)
      .orderBy(desc(storageOperations.createdAt))
      .limit(limit)
      .all();
  }
}
