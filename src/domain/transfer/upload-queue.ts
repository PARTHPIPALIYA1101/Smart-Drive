import { TransferService } from './transfer.service.js';
import { StorageOperationRepository } from '../../persistence/repositories/storage-operation.repository.js';
import { DomainEventBus } from '../events/event-bus.js';
import { VirtualFilesystemService } from '../vfs/vfs.service.js';
import { Readable } from 'node:stream';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { UploadConflictAction, ResumeSourceVerificationResult } from './transfer.types.js';
import { ResourceLimits } from '../../config/resource-limits.js';

export interface QueuedUploadItem {
  id: string;
  filename: string;
  relativePath: string;
  parentId: number | null;
  size: number;
  mimeType: string;
  conflictAction?: UploadConflictAction;
  sourcePath?: string;
  buffer?: Buffer;
  streamSupplier?: () => Readable;
  status: 'PENDING' | 'UPLOADING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'WAITING_FOR_SOURCE';
  bytesUploaded: number;
  error?: string;
  fileId?: number;
  operationId?: string;
  resumableSessionUri?: string;
  destDriveId?: number;
  sourceUnavailable?: boolean;
}

export interface QueuedUploadBatch {
  id: string;
  sourceType?: 'FILE' | 'FOLDER';
  sourcePath?: string;
  rootFolderName: string;
  rootSmartFileId?: number | null;
  parentId: number | null;
  totalFiles: number;
  totalBytes: number;
  completedFiles: number;
  completedBytes: number;
  status: 'PENDING' | 'UPLOADING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'WAITING_FOR_SOURCE';
  items: QueuedUploadItem[];
  createdAt: number;
  updatedAt: number;
}

export class UploadQueue {
  private batches = new Map<string, QueuedUploadBatch>();
  private activeUploads = 0;
  private maxConcurrency = ResourceLimits.MAX_CONCURRENT_UPLOADS;
  private queue: Array<{ batchId: string; itemIndex: number }> = [];
  private vfsService?: VirtualFilesystemService;
  private isProcessing = false;
  private progressThrottleMap = new Map<string, number>();

  constructor(
    private transferService: TransferService,
    private operationRepo: StorageOperationRepository,
    private eventBus: DomainEventBus,
    vfsServiceOrConcurrency?: VirtualFilesystemService | number,
    maxConcurrency = ResourceLimits.MAX_CONCURRENT_UPLOADS
  ) {
    if (typeof vfsServiceOrConcurrency === 'number') {
      this.maxConcurrency = vfsServiceOrConcurrency;
    } else {
      this.vfsService = vfsServiceOrConcurrency;
      this.maxConcurrency = maxConcurrency;
    }
  }

  /**
   * Enqueues a batch of files (e.g. from local folder upload or multi-file selection).
   * Automatically resolves and creates the virtual directory hierarchy so that
   * every single file retains its permanent, correct virtual parent_id.
   */
  enqueueBatch(batchInput: {
    sourceType?: 'FILE' | 'FOLDER';
    sourcePath?: string;
    rootFolderName: string;
    parentId: number | null;
    items: Array<{
      filename: string;
      relativePath: string;
      parentId?: number | null;
      size: number;
      mimeType: string;
      sourcePath?: string;
      buffer?: Buffer;
      streamSupplier?: () => Readable;
      conflictAction?: UploadConflictAction;
    }>;
  }): QueuedUploadBatch {
    const batchId = `BATCH-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const now = Date.now();

    // Cache for resolved directory paths within this batch: "path/to/dir" -> folderId
    const dirCache = new Map<string, number | null>();
    let rootSmartFileId: number | null = null;

    if (this.vfsService && batchInput.rootFolderName && batchInput.rootFolderName !== 'Smart Drive' && batchInput.rootFolderName !== '/') {
      const rootFolder = this.vfsService.ensureDirectoryPath(batchInput.parentId, [batchInput.rootFolderName]);
      rootSmartFileId = rootFolder.id;
    }

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
      let itemSourcePath = item.sourcePath;
      if (!itemSourcePath && batchInput.sourcePath) {
        itemSourcePath = path.join(batchInput.sourcePath, item.relativePath || item.filename);
      }

      let supplier = item.streamSupplier;
      if (!supplier && itemSourcePath) {
        const p = itemSourcePath;
        supplier = () => fs.createReadStream(p);
      }

      return {
        id: `${batchId}-${idx}`,
        filename: cleanFilename,
        relativePath: item.relativePath || item.filename,
        parentId: resolvedParentId,
        size: item.size,
        mimeType: item.mimeType || 'application/octet-stream',
        sourcePath: itemSourcePath,
        buffer: item.buffer,
        streamSupplier: supplier,
        conflictAction: item.conflictAction || 'SKIP',
        status: 'PENDING',
        bytesUploaded: 0,
      };
    });

    const totalBytes = items.reduce((acc, i) => acc + (i.size || 0), 0);

    const batch: QueuedUploadBatch = {
      id: batchId,
      sourceType: batchInput.sourceType || 'FOLDER',
      sourcePath: batchInput.sourcePath,
      rootFolderName: batchInput.rootFolderName,
      rootSmartFileId,
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
        sourceType: batch.sourceType,
        sourcePath: batch.sourcePath,
        rootFolderName: batchInput.rootFolderName,
        rootSmartFileId: batch.rootSmartFileId,
        parentId: batchInput.parentId,
        totalFiles: items.length,
        totalBytes,
        completedFiles: 0,
        completedBytes: 0,
        items: items.map((i) => ({
          id: i.id,
          filename: i.filename,
          relativePath: i.relativePath,
          parentId: i.parentId,
          size: i.size,
          mimeType: i.mimeType,
          sourcePath: i.sourcePath,
          status: i.status,
          bytesUploaded: i.bytesUploaded,
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
   * Restores an incomplete batch from persisted database state (on restart or recovery).
   */
  restoreBatch(batch: QueuedUploadBatch): void {
    // Re-bind stream suppliers for non-completed items from their sourcePath
    batch.items.forEach((item, idx) => {
      if (item.status !== 'COMPLETED') {
        let itemPath = item.sourcePath;
        if (!itemPath && batch.sourcePath) {
          itemPath = path.join(batch.sourcePath, item.relativePath || item.filename);
          item.sourcePath = itemPath;
        }

        if (itemPath && fs.existsSync(itemPath)) {
          const p = itemPath;
          item.streamSupplier = () => fs.createReadStream(p, { start: item.bytesUploaded || 0 });
          item.status = 'PENDING';
          this.queue.push({ batchId: batch.id, itemIndex: idx });
        } else {
          item.status = 'WAITING_FOR_SOURCE';
          item.sourceUnavailable = true;
        }
      }
    });

    const anyWaiting = batch.items.some((i) => i.status === 'WAITING_FOR_SOURCE');
    batch.status = anyWaiting && batch.completedFiles < batch.totalFiles ? 'WAITING_FOR_SOURCE' : 'UPLOADING';
    this.batches.set(batch.id, batch);

    if (batch.status === 'UPLOADING') {
      this.processNext();
    }
  }

  /**
   * Verifies candidate replacement folder for an incomplete batch.
   */
  verifySourceFolder(batchId: string, candidatePath: string): ResumeSourceVerificationResult {
    const batch = this.batches.get(batchId) || this.loadBatchFromDb(batchId);
    if (!batch) {
      return { valid: false, error: 'Batch not found', matchedFiles: 0, missingFiles: [] };
    }

    if (!fs.existsSync(candidatePath) || !fs.statSync(candidatePath).isDirectory()) {
      return { valid: false, error: 'Specified path is not a valid directory', matchedFiles: 0, missingFiles: [] };
    }

    // Verify folder name
    const candidateBase = path.basename(candidatePath);
    if (
      batch.rootFolderName &&
      batch.rootFolderName !== 'Smart Drive' &&
      batch.rootFolderName !== 'Uploaded Folder' &&
      batch.rootFolderName !== candidateBase
    ) {
      // Check if folder contains expected root structure or matches name
    }

    const missingFiles: string[] = [];
    let matchedFiles = 0;

    for (const item of batch.items) {
      if (item.status === 'COMPLETED') {
        continue;
      }

      // Try path directly relative to candidate folder
      const cleanRel = (item.relativePath || item.filename).replace(/\\/g, '/');
      let targetFile = path.join(candidatePath, cleanRel);

      // If relativePath starts with rootFolderName, also try stripping rootFolderName
      if (!fs.existsSync(targetFile) && batch.rootFolderName && cleanRel.startsWith(batch.rootFolderName + '/')) {
        const subRel = cleanRel.slice(batch.rootFolderName.length + 1);
        const altFile = path.join(candidatePath, subRel);
        if (fs.existsSync(altFile)) {
          targetFile = altFile;
        }
      }

      if (fs.existsSync(targetFile)) {
        const stats = fs.statSync(targetFile);
        if (stats.size === item.size) {
          matchedFiles++;
        } else {
          missingFiles.push(`${cleanRel} (size mismatch: expected ${item.size} bytes, found ${stats.size} bytes)`);
        }
      } else {
        missingFiles.push(cleanRel);
      }
    }

    if (missingFiles.length > 0 && matchedFiles === 0) {
      return {
        valid: false,
        error: `Folder does not match expected batch content. Missing ${missingFiles.length} file(s).`,
        matchedFiles,
        missingFiles,
      };
    }

    return {
      valid: true,
      matchedFiles,
      missingFiles,
    };
  }

  /**
   * Resumes an incomplete batch with an existing or verified replacement source folder.
   */
  async resumeBatch(batchId: string, newSourcePath?: string): Promise<boolean> {
    let batch = this.batches.get(batchId);
    if (!batch) {
      batch = this.loadBatchFromDb(batchId);
    }
    if (!batch || batch.status === 'COMPLETED' || batch.status === 'CANCELLED') {
      return false;
    }

    const rootPath = newSourcePath || batch.sourcePath;
    if (!rootPath || !fs.existsSync(rootPath)) {
      batch.status = 'WAITING_FOR_SOURCE';
      this.operationRepo.updateStatus(batchId, 'WAITING_FOR_SOURCE');
      return false;
    }

    batch.sourcePath = rootPath;
    batch.status = 'UPLOADING';
    this.operationRepo.updateStatus(batchId, 'EXECUTING');

    batch.items.forEach((item, idx) => {
      if (item.status !== 'COMPLETED') {
        const cleanRel = (item.relativePath || item.filename).replace(/\\/g, '/');
        let fullPath = path.join(rootPath, cleanRel);

        if (!fs.existsSync(fullPath) && batch!.rootFolderName && cleanRel.startsWith(batch!.rootFolderName + '/')) {
          const subRel = cleanRel.slice(batch!.rootFolderName.length + 1);
          const altFile = path.join(rootPath, subRel);
          if (fs.existsSync(altFile)) {
            fullPath = altFile;
          }
        }

        if (fs.existsSync(fullPath)) {
          item.sourcePath = fullPath;
          const p = fullPath;
          item.streamSupplier = () => fs.createReadStream(p, { start: item.bytesUploaded || 0 });
          item.status = 'PENDING';
          item.sourceUnavailable = false;
          if (!this.queue.some((q) => q.batchId === batchId && q.itemIndex === idx)) {
            this.queue.push({ batchId, itemIndex: idx });
          }
        } else {
          item.status = 'FAILED';
          item.error = 'Source file missing';
          item.sourceUnavailable = true;
        }
      }
    });

    this.persistBatchState(batch);
    this.processNext();
    return true;
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
    return this.batches.get(batchId) || this.loadBatchFromDb(batchId);
  }

  /**
   * Cancels an upload batch.
   */
  cancelBatch(batchId: string): boolean {
    const batch = this.batches.get(batchId) || this.loadBatchFromDb(batchId);
    if (!batch || batch.status === 'COMPLETED' || batch.status === 'CANCELLED') {
      return false;
    }

    batch.status = 'CANCELLED';
    batch.updatedAt = Date.now();

    // Mark pending items in this batch as cancelled
    batch.items.forEach((item) => {
      if (item.status === 'PENDING' || item.status === 'WAITING_FOR_SOURCE') {
        item.status = 'CANCELLED';
      }
    });

    // Remove from queue
    this.queue = this.queue.filter((q) => q.batchId !== batchId);

    this.operationRepo.updateStatus(batchId, 'CANCELLED', 'USER_CANCELLED', 'User cancelled upload batch');
    this.persistBatchState(batch);
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
      // Check source availability on disk if sourcePath is present
      if (item.sourcePath) {
        if (!fs.existsSync(item.sourcePath)) {
          item.status = 'FAILED';
          item.error = `Source file unavailable at ${item.sourcePath}`;
          item.sourceUnavailable = true;
          batch.updatedAt = Date.now();
          this.persistBatchState(batch);
          this.eventBus.publish('UPLOAD_FAILED', {
            batchId: batch.id,
            filename: item.filename,
            error: item.error,
          });
          return;
        }
      }

      let stream: Readable;
      if (item.streamSupplier) {
        stream = item.streamSupplier();
      } else if (item.sourcePath) {
        stream = fs.createReadStream(item.sourcePath);
      } else if (item.buffer) {
        stream = Readable.from(item.buffer);
      } else {
        throw new Error('No upload data stream, source path, or buffer provided');
      }

      const result = await this.transferService.uploadFile({
        name: item.filename,
        parentId: item.parentId,
        mimeType: item.mimeType,
        size: item.size,
        stream,
        conflictAction: item.conflictAction || 'SKIP',
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

      this.persistBatchState(batch);

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

      this.persistBatchState(batch);

      this.eventBus.publish('UPLOAD_FAILED', {
        batchId: batch.id,
        filename: item.filename,
        error: item.error,
      });
    }
  }

  private persistBatchState(batch: QueuedUploadBatch): void {
    try {
      this.operationRepo.updatePlanContext(
        batch.id,
        JSON.stringify({
          sourceType: batch.sourceType || 'FOLDER',
          sourcePath: batch.sourcePath,
          rootFolderName: batch.rootFolderName,
          rootSmartFileId: batch.rootSmartFileId,
          parentId: batch.parentId,
          totalFiles: batch.totalFiles,
          totalBytes: batch.totalBytes,
          completedFiles: batch.completedFiles,
          completedBytes: batch.completedBytes,
          status: batch.status,
          items: batch.items.map((i) => ({
            id: i.id,
            filename: i.filename,
            relativePath: i.relativePath,
            parentId: i.parentId,
            size: i.size,
            mimeType: i.mimeType,
            sourcePath: i.sourcePath,
            status: i.status,
            bytesUploaded: i.bytesUploaded,
            fileId: i.fileId,
            error: i.error,
            sourceUnavailable: i.sourceUnavailable,
          })),
        })
      );
    } catch {
      // Non-blocking persistence
    }
  }

  private loadBatchFromDb(batchId: string): QueuedUploadBatch | undefined {
    const op = this.operationRepo.findById(batchId);
    if (!op || !op.planContext) return undefined;

    try {
      const data = JSON.parse(op.planContext);
      if (!Array.isArray(data.items)) return undefined;

      const batch: QueuedUploadBatch = {
        id: batchId,
        sourceType: data.sourceType || 'FOLDER',
        sourcePath: data.sourcePath,
        rootFolderName: data.rootFolderName || 'Uploaded Folder',
        rootSmartFileId: data.rootSmartFileId,
        parentId: data.parentId ?? null,
        totalFiles: data.totalFiles || data.items.length,
        totalBytes: data.totalBytes || 0,
        completedFiles: data.completedFiles || 0,
        completedBytes: data.completedBytes || 0,
        status: (op.status as any) || data.status || 'UPLOADING',
        items: data.items.map((i: any) => ({
          id: i.id,
          filename: i.filename,
          relativePath: i.relativePath || i.filename,
          parentId: i.parentId ?? null,
          size: i.size || 0,
          mimeType: i.mimeType || 'application/octet-stream',
          sourcePath: i.sourcePath,
          status: i.status || 'PENDING',
          bytesUploaded: i.bytesUploaded || 0,
          fileId: i.fileId,
          error: i.error,
          sourceUnavailable: i.sourceUnavailable,
        })),
        createdAt: op.createdAt,
        updatedAt: op.completedAt || op.createdAt,
      };

      this.batches.set(batchId, batch);
      return batch;
    } catch {
      return undefined;
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

