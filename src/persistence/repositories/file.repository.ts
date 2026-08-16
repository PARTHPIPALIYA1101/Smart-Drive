import { eq, and, isNull, sql } from 'drizzle-orm';
import { AppDatabase } from '../db.js';
import { files, FileInsert, FileSelect } from '../schema/files.js';

export class FileRepository {
  constructor(private db: AppDatabase) {}

  insert(data: FileInsert): FileSelect {
    return this.db.insert(files).values(data).returning().get();
  }

  findById(id: number): FileSelect | undefined {
    return this.db.select().from(files).where(eq(files.id, id)).get();
  }

  findByParentId(parentId: number | null): FileSelect[] {
    if (parentId === null) {
      return this.db.select().from(files).where(isNull(files.parentId)).all();
    }
    return this.db.select().from(files).where(eq(files.parentId, parentId)).all();
  }

  findActiveByParentId(parentId: number | null): FileSelect[] {
    if (parentId === null) {
      return this.db
        .select()
        .from(files)
        .where(and(isNull(files.parentId), eq(files.lifecycleStatus, 'ACTIVE')))
        .all();
    }
    return this.db
      .select()
      .from(files)
      .where(and(eq(files.parentId, parentId), eq(files.lifecycleStatus, 'ACTIVE')))
      .all();
  }

  findTrashed(): FileSelect[] {
    return this.db
      .select()
      .from(files)
      .where(eq(files.lifecycleStatus, 'TRASHED'))
      .all();
  }

  update(id: number, data: Partial<Omit<FileInsert, 'id'>>): FileSelect | undefined {
    return this.db
      .update(files)
      .set({ ...data, updatedAt: Date.now() })
      .where(eq(files.id, id))
      .returning()
      .get();
  }

  trash(id: number): FileSelect | undefined {
    const now = Date.now();
    return this.db
      .update(files)
      .set({ lifecycleStatus: 'TRASHED', trashedAt: now, updatedAt: now })
      .where(eq(files.id, id))
      .returning()
      .get();
  }

  trashRecursive(id: number): number {
    return this.db.transaction((tx) => {
      const now = Date.now();
      let affected = 0;

      const markTrashed = (nodeId: number) => {
        const res = tx
          .update(files)
          .set({ lifecycleStatus: 'TRASHED', trashedAt: now, updatedAt: now })
          .where(eq(files.id, nodeId))
          .run();
        affected += res.changes;

        // Traverse children
        const children = tx.select().from(files).where(eq(files.parentId, nodeId)).all();
        for (const child of children) {
          markTrashed(child.id);
        }
      };

      markTrashed(id);
      return affected;
    });
  }

  restore(id: number): FileSelect | undefined {
    const now = Date.now();
    return this.db
      .update(files)
      .set({ lifecycleStatus: 'ACTIVE', trashedAt: null, updatedAt: now })
      .where(eq(files.id, id))
      .returning()
      .get();
  }

  restoreRecursive(id: number): number {
    return this.db.transaction((tx) => {
      const now = Date.now();
      let affected = 0;

      const markRestored = (nodeId: number) => {
        const res = tx
          .update(files)
          .set({ lifecycleStatus: 'ACTIVE', trashedAt: null, updatedAt: now })
          .where(eq(files.id, nodeId))
          .run();
        affected += res.changes;

        // Traverse children
        const children = tx.select().from(files).where(eq(files.parentId, nodeId)).all();
        for (const child of children) {
          markRestored(child.id);
        }
      };

      markRestored(id);
      return affected;
    });
  }

  emptyTrash(): number {
    const result = this.db
      .delete(files)
      .where(eq(files.lifecycleStatus, 'TRASHED'))
      .run();
    return result.changes;
  }

  deletePermanently(id: number): boolean {
    const result = this.db.delete(files).where(eq(files.id, id)).run();
    return result.changes > 0;
  }

  /**
   * Retrieves array of ancestor IDs starting from target parentId up to the root.
   * Used for cycle detection.
   */
  getAncestorIds(startParentId: number | null): number[] {
    const ancestors: number[] = [];
    let currentId: number | null = startParentId;
    const visited = new Set<number>();

    while (currentId !== null) {
      if (visited.has(currentId)) {
        break;
      }
      visited.add(currentId);
      ancestors.push(currentId);

      const parentNode = this.findById(currentId);
      if (!parentNode || parentNode.parentId === null) {
        break;
      }
      currentId = parentNode.parentId;
    }

    return ancestors;
  }

  countActive(isFolder?: boolean): number {
    const conditions = [eq(files.lifecycleStatus, 'ACTIVE')];
    if (isFolder !== undefined) {
      conditions.push(eq(files.isFolder, isFolder));
    }
    const res = this.db
      .select({ count: sql<number>`count(*)` })
      .from(files)
      .where(and(...conditions))
      .get();
    return res?.count ?? 0;
  }

  countTrashed(): number {
    const res = this.db
      .select({ count: sql<number>`count(*)` })
      .from(files)
      .where(eq(files.lifecycleStatus, 'TRASHED'))
      .get();
    return res?.count ?? 0;
  }

  sumActiveLogicalBytes(): number {
    const res = this.db
      .select({ totalBytes: sql<number>`COALESCE(SUM(${files.size}), 0)` })
      .from(files)
      .where(and(eq(files.lifecycleStatus, 'ACTIVE'), eq(files.isFolder, false)))
      .get();
    return res?.totalBytes ?? 0;
  }
}
