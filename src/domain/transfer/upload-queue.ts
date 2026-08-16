import { TransferService } from './transfer.service.js';
import { StorageOperationRepository } from '../../persistence/repositories/storage-operation.repository.js';
import { DomainEventBus } from '../events/event-bus.js';
import { VirtualFilesystemService } from '../vfs/vfs.service.js';
import { Readable } from 'node:stream';
import { UploadConflictAction } from './transfer.types.js';

export interface QueuedUploadItem {
  id: string;
  filename: string;
  relativePath: string;
  parentId: number | null;
  size: number;
  mimeType: string;
  conflictAction?: UploadConflictAction;
  buffer?: Buffer;
  streamSupplier?: () => Readable;
  status: 'PENDING' | 'UPLOADING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  bytesUploaded: number;
  error?: string;
  fileId?: number;
}

export interface QueuedUploadBatch {
  id: string;
  rootFolderName: string;
  parentId: number | null;
  totalFiles: number;
  totalBytes: number;
  completedFiles: number;
  completedBytes: number;
  status: 'PENDING' | 'UPLOADING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  items: QueuedUploadItem[];
  createdAt: number;
  updatedAt: number;
}

export class UploadQueue {
  private batches = new Map<string, QueuedUploadBatch>();
  private activeUploads = 0;
  private maxConcurrency = 3;
  private queue: Array<{ batchId: string; itemIndex: number }> = [];
  private vfsService?: VirtualFilesystemService;
  private isProcessing = false;
  private progressThrottleMap = new Map<string, number>();

  constructor(
    private transferService: TransferService,
    private operationRepo: StorageOperationRepository,
    private eventBus: DomainEventBus,
    vfsServiceOrConcurrency?: VirtualFilesystemService | number,
    maxConcurrency = 3
  ) {
    if (typeof vfsServiceOrConcurrency === 'number') {
      this.maxConcurrency = vfsServiceOrConcurrency;
    } else {
      this.vfsService = vfsServiceOrConcurrency;
      this.maxConcurrency = maxConcurrency;
    }
  }

  /**
   * Enqueues a batch of files (e.g. from folder upload or multi-file selection).
   * Automatically resolves and creates the virtual directory hierarchy so that
   * every single file retains its permanent, correct virtual parent_id.
   */
  enqueueBatch(batchInput: {
    rootFolderName: string;
    parentId: number | null;
    items: Array<{
      filename: string;
      relativePath: string;
      parentId?: number | null;
      size: number;
      mimeType: string;
      buffer?: Buffer;
      streamSupplier?: () => Readable;
      conflictAction?: UploadConflictAction;
    }>;
  }): QueuedUploadBatch {
    const batchId = `BATCH-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const now = Date.now();

    // Cache for resolved directory paths within this batch: "path/to/dir" -> folderId
    const dirCache = new Map<string, number | null>();

    const items: QueuedUploadItem[] = batchInput.items.map((item, idx) => {
      let resolvedParentId: number | null = item.parentId !== undefined ? item.parentId : batchInput.parentId;

      if (this.vfsService) {
        const cleanRel = (item.relativePath || item.filename).replace(/\\/g, '/');
        let parts = cleanRel.split('/').filter(Boolean);

        // If filename is last part, directory segments are parts.slice(0, -1)
        let dirParts: string[] = [];
        if (parts.length > 1) {
          dirParts = parts.slice(0, -1);
        } else if (batchInput.rootFolderName && batchInput.rootFolderName !== 'Smart Drive' && batchInput.rootFolderName !== '/') {
          dirParts = [batchInput.rootFolderName];
        }

        if (dirParts.length > 0) {
          const dirKey = `${batchInput.parentId ?? 'root'}:${dirParts.join('/')}`;
          if (dirCache.has(dirKey)) {
            resolvedParentId = dirCache.get(dirKey)!;
          } else {
            const leafFolder = this.vfsService.ensureDirectoryPath(batchInput.parentId, dirParts);
            resolvedParentId = leafFolder.id;
            dirCache.set(dirKey, resolvedParentId);
          }
        }
      }

      const cleanFilename = item.filename || item.relativePath.split('/').pop() || 'Untitled';

      return {
        id: `${batchId}-${idx}`,
        filename: cleanFilename,
        relativePath: item.relativePath || item.filename,
        parentId: resolvedParentId,
        size: item.size,
        mimeType: item.mimeType || 'application/octet-stream',
        buffer: item.buffer,
        streamSupplier: item.streamSupplier,
        conflictAction: item.conflictAction || 'SKIP',
        status: 'PENDING',
        bytesUploaded: 0,
      };
    });

    const totalBytes = items.reduce((acc, i) => acc + (i.size || 0), 0);

    const batch: QueuedUploadBatch = {
      id: batchId,
      rootFolderName: batchInput.rootFolderName,
      parentId: batchInput.parentId,
      totalFiles: items.length,
      totalBytes,
      completedFiles: 0,
      completedBytes: 0,
      status: 'UPLOADING',
      items,
      createdAt: now,
      updatedAt: now,
    };

    this.batches.set(batchId, batch);

    // Save parent batch operation in storage_operations with complete manifest
    this.operationRepo.insert({
      id: batchId,
      operationType: 'UPLOAD',
      requestedBytes: totalBytes,
      status: 'EXECUTING',
      planContext: JSON.stringify({
        rootFolderName: batchInput.rootFolderName,
        parentId: batchInput.parentId,
        totalFiles: items.length,
        totalBytes,
        items: items.map((i) => ({
          filename: i.filename,
          relativePath: i.relativePath,
          parentId: i.parentId,
          size: i.size,
        })),
      }),
      createdAt: now,
    });

    items.forEach((_, idx) => {
      this.queue.push({ batchId, itemIndex: idx });
    });

    this.eventBus.publish('UPLOAD_QUEUED', {
      batchId,
      rootFolderName: batch.rootFolderName,
      totalFiles: batch.totalFiles,
      totalBytes: batch.totalBytes,
    });

    this.processNext();

    return batch;
  }

  /**
   * Retrieves all currently active and recent upload batches for UI display.
   */
  getActiveBatches(): QueuedUploadBatch[] {
    return Array.from(this.batches.values());
  }

  /**
   * Retrieves a specific batch by ID.
   */
  getBatch(batchId: string): QueuedUploadBatch | undefined {
    return this.batches.get(batchId);
  }

  /**
   * Cancels an upload batch.
   */
  cancelBatch(batchId: string): boolean {
    const batch = this.batches.get(batchId);
    if (!batch || batch.status === 'COMPLETED' || batch.status === 'CANCELLED') {
      return false;
    }

    batch.status = 'CANCELLED';
    batch.updatedAt = Date.now();

    // Mark pending items in this batch as cancelled
    batch.items.forEach((item) => {
      if (item.status === 'PENDING') {
        item.status = 'CANCELLED';
      }
    });

    // Remove from queue
    this.queue = this.queue.filter((q) => q.batchId !== batchId);

    this.operationRepo.updateStatus(batchId, 'CANCELLED', 'USER_CANCELLED', 'User cancelled upload batch');
    this.eventBus.publish('UPLOAD_CANCELLED', { batchId });

    return true;
  }

  private async processNext(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      while (this.activeUploads < this.maxConcurrency && this.queue.length > 0) {
        const next = this.queue.shift();
        if (!next) break;

        const batch = this.batches.get(next.batchId);
        if (!batch || batch.status === 'CANCELLED') {
          continue;
        }

        const item = batch.items[next.itemIndex];
        if (!item || item.status === 'CANCELLED' || item.status === 'COMPLETED') {
          continue;
        }

        this.activeUploads++;
        this.executeItemUpload(batch, item).finally(() => {
          this.activeUploads--;
          this.processNext();
        });
      }
    } finally {
      this.isProcessing = false;
    }
  }

  private async executeItemUpload(batch: QueuedUploadBatch, item: QueuedUploadItem): Promise<void> {
    item.status = 'UPLOADING';
    this.emitThrottledProgress(batch, item);

    try {
      let stream: Readable;
      if (item.streamSupplier) {
        stream = item.streamSupplier();
      } else if (item.buffer) {
        stream = Readable.from(item.buffer);
      } else {
        throw new Error('No upload data stream or buffer provided');
      }

      const result = await this.transferService.uploadFile({
        name: item.filename,
        parentId: item.parentId,
        mimeType: item.mimeType,
        size: item.size,
        stream,
        conflictAction: item.conflictAction,
      });

      item.status = 'COMPLETED';
      item.fileId = result.file.id;
      item.bytesUploaded = item.size;
      batch.completedFiles++;
      batch.completedBytes += item.size;
      batch.updatedAt = Date.now();

      // Free buffer memory if present
      delete item.buffer;

      // Check if all items in batch are completed
      const allDone = batch.items.every(
        (i) => i.status === 'COMPLETED' || i.status === 'FAILED' || i.status === 'CANCELLED'
      );

      if (allDone) {
        const anySuccess = batch.items.some((i) => i.status === 'COMPLETED');
        batch.status = anySuccess ? 'COMPLETED' : 'FAILED';
        this.operationRepo.updateStatus(batch.id, batch.status);
        this.eventBus.publish('UPLOAD_COMPLETED', {
          batchId: batch.id,
          rootFolderName: batch.rootFolderName,
          totalFiles: batch.totalFiles,
          completedFiles: batch.completedFiles,
          totalBytes: batch.totalBytes,
          completedBytes: batch.completedBytes,
        });
      } else {
        this.emitThrottledProgress(batch, item);
      }
    } catch (err: any) {
      item.status = 'FAILED';
      item.error = err?.message || 'Upload failed';
      batch.updatedAt = Date.now();

      const allDone = batch.items.every(
        (i) => i.status === 'COMPLETED' || i.status === 'FAILED' || i.status === 'CANCELLED'
      );
      if (allDone) {
        batch.status = batch.completedFiles > 0 ? 'COMPLETED' : 'FAILED';
        this.operationRepo.updateStatus(batch.id, batch.status);
      }

      this.eventBus.publish('UPLOAD_FAILED', {
        batchId: batch.id,
        filename: item.filename,
        error: item.error,
      });
    }
  }

  private emitThrottledProgress(batch: QueuedUploadBatch, currentItem: QueuedUploadItem): void {
    const now = Date.now();
    const lastTime = this.progressThrottleMap.get(batch.id) || 0;

    // Throttle progress events to at most once per 200ms per batch
    if (now - lastTime > 200 || batch.completedFiles === batch.totalFiles) {
      this.progressThrottleMap.set(batch.id, now);
      this.eventBus.publish('UPLOAD_PROGRESS', {
        batchId: batch.id,
        rootFolderName: batch.rootFolderName,
        totalFiles: batch.totalFiles,
        completedFiles: batch.completedFiles,
        totalBytes: batch.totalBytes,
        completedBytes: batch.completedBytes,
        currentFile: currentItem.filename,
        percentage: batch.totalBytes > 0 ? Math.round((batch.completedBytes / batch.totalBytes) * 100) : 0,
      });
    }
  }
}
