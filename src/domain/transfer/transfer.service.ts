import { FileRepository } from '../../persistence/repositories/file.repository.js';
import { FileLocationRepository } from '../../persistence/repositories/file-location.repository.js';
import { GoogleAccountRepository } from '../../persistence/repositories/google-account.repository.js';
import { StorageOperationRepository } from '../../persistence/repositories/storage-operation.repository.js';
import { StorageReservationRepository } from '../../persistence/repositories/storage-reservation.repository.js';
import { CapacityService } from '../capacity/capacity.service.js';
import { IProviderFactory } from '../../providers/provider-factory.js';
import { PathUtils } from '../vfs/path-utils.js';
import { DomainEventBus } from '../events/event-bus.js';
import {
  UploadFileInput,
  DownloadFileOutput,
  FileTransferResult,
  CopyFileInput,
  FolderUploadPlanInput,
  FolderUploadPlanResult,
  FolderFilePlacement,
  FolderFileItem,
  InitResumableUploadInput,
  InitResumableUploadResult,
  ResumeUploadStreamInput,
} from './transfer.types.js';
import {
  EntityNotFoundError,
  InsufficientCapacityError,
  DriveUnavailableError,
} from '../errors.js';
import { DuplicateSiblingError, InvalidParentError } from '../vfs/vfs.service.js';
import { TransferSessionManager } from './transfer-session-manager.js';

export class TransferService {
  constructor(
    private fileRepo: FileRepository,
    private locationRepo: FileLocationRepository,
    private accountRepo: GoogleAccountRepository,
    private operationRepo: StorageOperationRepository,
    private reservationRepo: StorageReservationRepository,
    private capacityService: CapacityService,
    private providerFactory: IProviderFactory,
    private eventBus?: DomainEventBus,
    private sessionManager?: TransferSessionManager
  ) {}

  private normalizeParentId(parentId: number | null | undefined): number | null {
    if (parentId === 0 || parentId === undefined || parentId === null || Number.isNaN(parentId)) {
      return null;
    }
    return parentId;
  }

  /**
   * Performs pre-upload capacity planning and placement simulation for a folder upload.
   * Ensures every single file fits completely on an available drive without chunking
   * and that total folder size does not exceed unified available storage.
   */
  planFolderUpload(input: FolderUploadPlanInput): FolderUploadPlanResult {
    const files: FolderFileItem[] = input.files || [];
    const totalFiles = files.length;
    const totalBytes = files.reduce((acc: number, f: FolderFileItem) => acc + (f.size || 0), 0);
    const largestFileSize = files.reduce((max: number, f: FolderFileItem) => Math.max(max, f.size || 0), 0);

    const report = this.capacityService.getUnifiedCapacityReport();
    const candidateDrives = report.drives.filter(
      (d) => (d.status === 'AVAILABLE' || d.status === 'DEGRADED') && !d.migrationLocked
    );

    // 1. Check if total storage is sufficient
    if (report.totalUsableBytes < totalBytes) {
      throw new InsufficientCapacityError(
        `Folder cannot be uploaded completely. Total folder size: ${totalBytes} bytes. Unified available capacity: ${report.totalUsableBytes} bytes. (Deficit: ${totalBytes - report.totalUsableBytes} bytes).`,
        { requestedBytes: totalBytes, totalUsableBytes: report.totalUsableBytes }
      );
    }

    // 2. Check if largest file fits on at least one single drive
    if (largestFileSize > report.largestSingleFileCapacity) {
      throw new InsufficientCapacityError(
        `Folder cannot be uploaded completely. Total folder size: ${totalBytes} bytes. Largest file: ${largestFileSize} bytes. Largest usable single-Drive capacity: ${report.largestSingleFileCapacity} bytes. Reason: No available Drive can hold the ${largestFileSize} byte file.`,
        { requestedBytes: totalBytes, largestCapacity: report.largestSingleFileCapacity, largestFileSize }
      );
    }

    // 3. Simulate multi-drive placement across candidate drives without chunking
    const simulatedSpace = new Map<number, number>();
    candidateDrives.forEach((d) => simulatedSpace.set(d.accountId, d.usableSpace));

    // Sort files by size descending for optimal Best-Fit Decreasing packing simulation
    const sortedIndices = files
      .map((f: FolderFileItem, idx: number) => ({ ...f, originalIndex: idx }))
      .sort((a, b) => b.size - a.size);

    const placementsByIndex = new Map<number, { destDriveId: number; destDriveName: string }>();

    for (const item of sortedIndices) {
      // Find candidate drive with maximum simulated usable space that fits this file
      let bestDriveId: number | null = null;
      let bestDriveName = '';
      let maxAvailable = -1;

      for (const drive of candidateDrives) {
        const currentFree = simulatedSpace.get(drive.accountId) ?? 0;
        if (currentFree >= item.size && currentFree > maxAvailable) {
          maxAvailable = currentFree;
          bestDriveId = drive.accountId;
          bestDriveName = drive.displayName;
        }
      }

      if (bestDriveId === null) {
        throw new InsufficientCapacityError(
          `Folder cannot be uploaded completely. Files cannot be distributed across available Drives without oversubscribing individual Drive capacities. (Failed to allocate ${item.size} bytes for "${item.relativePath}").`,
          { requestedBytes: totalBytes, failedFile: item.relativePath, fileSize: item.size }
        );
      }

      simulatedSpace.set(bestDriveId, maxAvailable - item.size);
      placementsByIndex.set(item.originalIndex, { destDriveId: bestDriveId, destDriveName: bestDriveName });
    }

    const placements: FolderFilePlacement[] = files.map((f: FolderFileItem, idx: number) => {
      const assigned = placementsByIndex.get(idx)!;
      const cleanRelativePath = f.relativePath.replace(/\\/g, '/');
      const filename = cleanRelativePath.split('/').pop() || f.relativePath;
      return {
        relativePath: cleanRelativePath,
        filename,
        size: f.size,
        mimeType: f.mimeType || 'application/octet-stream',
        destDriveId: assigned.destDriveId,
        destDriveName: assigned.destDriveName,
      };
    });

    return {
      planId: `FPLAN-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      rootFolderName: input.rootFolderName,
      parentId: input.parentId,
      totalFiles,
      totalBytes,
      largestFileSize,
      placements,
    };
  }

  /**
   * Initializes a resumable upload operation and reserves drive capacity.
   */
  async initResumableUpload(input: InitResumableUploadInput): Promise<InitResumableUploadResult> {
    const normParentId = this.normalizeParentId(input.parentId);
    let validName = PathUtils.validateNodeName(input.name);

    // 1. Validate Parent Folder
    if (normParentId !== null) {
      const parent = this.fileRepo.findById(normParentId);
      if (!parent) {
        throw new EntityNotFoundError('Parent folder', normParentId);
      }
      if (!parent.isFolder) {
        throw new InvalidParentError(`Parent ID ${normParentId} is a file, not a folder`);
      }
      if (parent.lifecycleStatus !== 'ACTIVE') {
        throw new InvalidParentError(`Parent folder ${normParentId} is not active`);
      }
    }

    // 2. Validate Sibling Duplicate Name & Apply Conflict Actions
    const siblings = this.fileRepo.findActiveByParentId(normParentId);
    const existingSibling = siblings.find((s) => s.name.toLowerCase() === validName.toLowerCase());

    if (existingSibling) {
      const conflictAction = input.conflictAction || 'FAIL';

      if (conflictAction === 'SKIP') {
        const loc = this.locationRepo.findActiveByFileId(existingSibling.id);
        const op: any = {
          id: `OP-SKIPPED-${existingSibling.id}`,
          operationType: 'UPLOAD',
          fileId: existingSibling.id,
          requestedBytes: existingSibling.size,
          status: 'COMPLETED',
          createdAt: Date.now(),
        };
        return {
          operationId: op.id,
          destDriveId: loc?.googleAccountId || 0,
          startByte: existingSibling.size,
          skipped: true,
          file: existingSibling,
          location: loc || ({} as any),
          operation: op,
        };
      } else if (conflictAction === 'REPLACE') {
        await this.deleteFilePhysically(existingSibling.id);
      } else if (conflictAction === 'RENAME') {
        const dotIdx = validName.lastIndexOf('.');
        const base = dotIdx !== -1 ? validName.slice(0, dotIdx) : validName;
        const ext = dotIdx !== -1 ? validName.slice(dotIdx) : '';
        let counter = 1;
        while (siblings.some((s) => s.name.toLowerCase() === `${base} (${counter})${ext}`.toLowerCase())) {
          counter++;
        }
        validName = `${base} (${counter})${ext}`;
      } else {
        throw new DuplicateSiblingError(validName, normParentId);
      }
    }

    // 3. Direct Placement Drive Selection (MAX_USABLE_FREE_SPACE)
    const report = this.capacityService.getUnifiedCapacityReport();
    const candidateDrives = report.drives.filter(
      (d) => (d.status === 'AVAILABLE' || d.status === 'DEGRADED') && d.usableSpace >= input.size
    );

    if (candidateDrives.length === 0) {
      throw new InsufficientCapacityError(
        `No single available Drive has sufficient capacity for ${input.size} bytes. (Largest usable capacity: ${report.largestSingleFileCapacity} bytes).`,
        { requestedBytes: input.size, largestCapacity: report.largestSingleFileCapacity }
      );
    }

    candidateDrives.sort((a, b) => b.usableSpace - a.usableSpace);
    const selectedDrive = candidateDrives[0];

    // 4. Create Operation & Acquire Atomic Reservation
    const opId = `OP-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const now = Date.now();

    this.operationRepo.insert({
      id: opId,
      operationType: 'UPLOAD',
      destDriveId: selectedDrive.accountId,
      requestedBytes: input.size,
      status: 'RESERVED',
      planContext: JSON.stringify({
        policy: 'MAX_USABLE_FREE_SPACE',
        selectedDriveId: selectedDrive.accountId,
        usableBefore: selectedDrive.usableSpace,
        fileName: validName,
        relativePath: input.relativePath || validName,
        parentId: normParentId,
        fileSize: input.size,
        mimeType: input.mimeType,
        batchId: input.batchId,
        conflictAction: input.conflictAction,
      }),
      createdAt: now,
    });

    try {
      this.reservationRepo.acquireAtomic(selectedDrive.accountId, opId, input.size);
    } catch (err) {
      this.operationRepo.updateStatus(opId, 'FAILED', 'RESERVATION_FAILED', (err as Error).message);
      this.eventBus?.publish('UPLOAD_FAILED', { operationId: opId, error: (err as Error).message });
      throw err;
    }

    // 5. Initialize Resumable Session on Provider
    const provider = this.providerFactory.getProvider(selectedDrive.accountId);
    let sessionUri: string | undefined;
    if (provider.createResumableSession) {
      try {
        sessionUri = await provider.createResumableSession({
          filename: validName,
          mimeType: input.mimeType,
          size: input.size,
        });
      } catch (sessionErr) {
        this.reservationRepo.releaseByOperationId(opId);
        const errMsg = sessionErr instanceof Error ? sessionErr.message : 'Failed to init session';
        this.operationRepo.updateStatus(opId, 'FAILED', 'UPLOAD_FAILED', errMsg);
        this.eventBus?.publish('UPLOAD_FAILED', { operationId: opId, error: errMsg });
        throw sessionErr;
      }
    }

    this.operationRepo.updateStatus(opId, 'EXECUTING');
    this.operationRepo.updatePlanContext(
      opId,
      JSON.stringify({
        policy: 'MAX_USABLE_FREE_SPACE',
        selectedDriveId: selectedDrive.accountId,
        usableBefore: selectedDrive.usableSpace,
        fileName: validName,
        relativePath: input.relativePath || validName,
        parentId: normParentId,
        fileSize: input.size,
        mimeType: input.mimeType,
        batchId: input.batchId,
        conflictAction: input.conflictAction,
        resumableSessionUri: sessionUri,
        destDriveId: selectedDrive.accountId,
      })
    );

    if (this.sessionManager) {
      this.sessionManager.registerSession({
        operationId: opId,
        destDriveId: selectedDrive.accountId,
        fileName: validName,
        relativePath: input.relativePath || validName,
        parentId: normParentId,
        fileSize: input.size,
        mimeType: input.mimeType,
        resumableSessionUri: sessionUri,
        batchId: input.batchId,
        conflictAction: input.conflictAction,
      });
    }

    this.eventBus?.publish('UPLOAD_PROGRESS', {
      operationId: opId,
      status: 'EXECUTING',
      filename: validName,
      bytesCompleted: 0,
      totalBytes: input.size,
    });

    return {
      operationId: opId,
      destDriveId: selectedDrive.accountId,
      resumableSessionUri: sessionUri,
      startByte: 0,
    };
  }

  /**
   * Resumes streaming from a specific byte offset into an active resumable upload session.
   */
  async resumeUploadStream(input: ResumeUploadStreamInput): Promise<FileTransferResult> {
    const op = this.operationRepo.findById(input.operationId);
    if (!op) {
      throw new EntityNotFoundError('Upload operation', input.operationId as any);
    }

    if (op.status === 'COMPLETED' && op.fileId) {
      const file = this.fileRepo.findById(op.fileId);
      const loc = this.locationRepo.findActiveByFileId(op.fileId);
      return {
        file: file!,
        location: loc || ({} as any),
        operation: op,
      };
    }

    if (op.status === 'CANCELLED') {
      throw new Error(`Upload operation ${input.operationId} was cancelled`);
    }

    let planData: any = {};
    try {
      planData = op.planContext ? JSON.parse(op.planContext) : {};
    } catch {}

    const destDriveId = op.destDriveId || planData.destDriveId;
    const provider = this.providerFactory.getProvider(destDriveId);
    const sessionUri = planData.resumableSessionUri;
    const filename = planData.fileName || 'Untitled';
    const mimeType = planData.mimeType || 'application/octet-stream';
    const totalBytes = op.requestedBytes || planData.fileSize || 0;
    const normParentId = planData.parentId !== undefined ? planData.parentId : null;

    if (this.sessionManager) {
      this.sessionManager.handleReconnect(input.operationId);
    }

    let providerMetadata: any;
    try {
      if (sessionUri && provider.uploadStreamToSession) {
        providerMetadata = await provider.uploadStreamToSession(sessionUri, input.stream, {
          startByte: input.startByte,
          totalBytes,
          mimeType,
          filename,
          abortSignal: input.abortSignal,
          isPartial: input.isPartial,
          onProgress: (bytesUploaded) => {
            if (this.sessionManager) {
              this.sessionManager.updateProgress(input.operationId, bytesUploaded);
            }
            if (input.onProgress) {
              input.onProgress(bytesUploaded);
            }
            this.eventBus?.publish('UPLOAD_PROGRESS', {
              operationId: input.operationId,
              status: 'EXECUTING',
              filename,
              bytesCompleted: bytesUploaded,
              totalBytes,
            });
          },
        });
      } else {
        providerMetadata = await provider.uploadStream(input.stream, {
          filename,
          mimeType,
          size: totalBytes,
          abortSignal: input.abortSignal,
          onProgress: (bytesUploaded) => {
            if (this.sessionManager) {
              this.sessionManager.updateProgress(input.operationId, bytesUploaded);
            }
            if (input.onProgress) {
              input.onProgress(bytesUploaded);
            }
          },
        });
      }
    } catch (uploadErr) {
      if (this.sessionManager) {
        this.sessionManager.handleDisconnect(input.operationId);
      } else {
        this.reservationRepo.releaseByOperationId(input.operationId);
        this.operationRepo.updateStatus(
          input.operationId,
          'FAILED',
          'UPLOAD_FAILED',
          uploadErr instanceof Error ? uploadErr.message : 'Unknown upload error'
        );
        this.eventBus?.publish('UPLOAD_FAILED', {
          operationId: input.operationId,
          error: uploadErr instanceof Error ? uploadErr.message : 'Unknown upload error',
        });
      }
      throw uploadErr;
    }

    // Check if this was a partial chunk / slice upload
    const isCompleted = input.isPartial !== true || providerMetadata.checksum !== null || (totalBytes > 0 && providerMetadata.size >= totalBytes);

    if (!isCompleted) {
      // Partial slice received: update progress and keep session alive in EXECUTING state
      const updatedOp = this.operationRepo.updatePlanContext(
        input.operationId,
        JSON.stringify({
          ...planData,
          bytesCompleted: providerMetadata.size,
        })
      );
      return {
        file: null as any,
        location: null as any,
        operation: updatedOp || op,
      };
    }

    // Full upload complete: record in virtual filesystem and physical locations
    let file = planData.smartFileId ? this.fileRepo.findById(planData.smartFileId) : undefined;
    const now = Date.now();

    if (!file) {
      file = this.fileRepo.insert({
        name: filename,
        parentId: normParentId,
        isFolder: false,
        mimeType: providerMetadata.mimeType || mimeType,
        size: providerMetadata.size || totalBytes,
        lifecycleStatus: 'ACTIVE',
        createdAt: now,
        updatedAt: now,
      });
    }

    let location = this.locationRepo.findActiveByFileId(file.id);
    if (!location) {
      location = this.locationRepo.insert({
        fileId: file.id,
        googleAccountId: destDriveId,
        providerFileId: providerMetadata.providerFileId,
        status: 'ACTIVE',
        size: providerMetadata.size || totalBytes,
        mimeType: providerMetadata.mimeType || mimeType,
        checksum: providerMetadata.checksum,
        checksumType: providerMetadata.checksumType || 'MD5',
        createdAt: now,
      });
    }

    // Update Drive capacity
    const driveAcc = this.accountRepo.findById(destDriveId);
    if (driveAcc) {
      this.accountRepo.updateCapacity(
        destDriveId,
        driveAcc.totalSpace,
        driveAcc.usedSpace + (providerMetadata.size || totalBytes)
      );
      this.eventBus?.publish('DRIVE_QUOTA_UPDATED', { accountId: destDriveId });
    }

    this.reservationRepo.commitByOperationId(input.operationId);
    const completedOp = this.operationRepo.updateStatus(input.operationId, 'COMPLETED')!;

    if (this.sessionManager) {
      this.sessionManager.completeSession(input.operationId);
    }

    this.eventBus?.publish('FILE_CREATED', file);
    this.eventBus?.publish('UPLOAD_COMPLETED', { file, location, operation: completedOp });

    return {
      file,
      location,
      operation: completedOp,
    };
  }

  /**
   * Uploads a file via direct placement (selecting the Drive with MAX_USABLE_FREE_SPACE).
   */
  async uploadFile(input: UploadFileInput): Promise<FileTransferResult> {
    const initRes = await this.initResumableUpload({
      name: input.name,
      parentId: input.parentId,
      mimeType: input.mimeType,
      size: input.size,
      conflictAction: input.conflictAction,
    });

    if (initRes.skipped && initRes.file && initRes.location && initRes.operation) {
      return {
        file: initRes.file,
        location: initRes.location,
        operation: initRes.operation,
        skipped: true,
      };
    }

    return this.resumeUploadStream({
      operationId: initRes.operationId,
      stream: input.stream,
      startByte: 0,
    });
  }

  /**
   * Downloads a file stream using its permanent Smart File ID.
   */
  async downloadFile(fileId: number): Promise<DownloadFileOutput> {
    const file = this.fileRepo.findById(fileId);
    if (!file) {
      throw new EntityNotFoundError('File', fileId);
    }

    if (file.isFolder) {
      throw new Error(`ID ${fileId} is a folder, not a file`);
    }

    if (file.lifecycleStatus !== 'ACTIVE') {
      throw new Error(`File ${file.name} is not in ACTIVE state (status: ${file.lifecycleStatus})`);
    }

    const activeLocation = this.locationRepo.findActiveByFileId(fileId);
    if (!activeLocation) {
      throw new Error(`No active physical location found for file ${file.name} (ID: ${fileId})`);
    }

    const account = this.accountRepo.findById(activeLocation.googleAccountId);
    if (!account || account.status === 'UNAVAILABLE' || account.status === 'DISCONNECTED') {
      throw new DriveUnavailableError(
        `The physical drive storing this file (${account?.displayName || 'Unknown'}) is currently unavailable.`
      );
    }

    const provider = this.providerFactory.getProvider(activeLocation.googleAccountId);
    const stream = await provider.downloadStream(activeLocation.providerFileId);

    const now = Date.now();
    this.fileRepo.update(fileId, {
      lastAccessedAt: now,
      lastDownloadedAt: now,
    });

    return {
      file,
      stream,
      mimeType: activeLocation.mimeType,
      size: activeLocation.size,
    };
  }

  /**
   * Duplicates/copies a virtual file.
   */
  async copyFile(input: CopyFileInput): Promise<FileTransferResult> {
    const sourceFile = this.fileRepo.findById(input.fileId);
    if (!sourceFile || sourceFile.isFolder) {
      throw new EntityNotFoundError('File', input.fileId);
    }

    const newFilename = input.newName || `Copy of ${sourceFile.name}`;
    const downloadData = await this.downloadFile(input.fileId);

    // Upload copy as a fresh direct placement file
    return this.uploadFile({
      name: newFilename,
      parentId: input.targetParentId,
      mimeType: downloadData.mimeType,
      size: downloadData.size,
      stream: downloadData.stream,
    });
  }

  /**
   * Permanently deletes physical copy on the provider and database entries.
   * If the target is a folder, recursively deletes all child files and subfolders physically.
   */
  async deleteFilePhysically(fileId: number): Promise<boolean> {
    const file = this.fileRepo.findById(fileId);
    if (!file) {
      return true; // Idempotent: already deleted
    }

    if (file.isFolder) {
      const children = this.fileRepo.findByParentId(fileId);
      for (const child of children) {
        await this.deleteFilePhysically(child.id);
      }
      return this.fileRepo.deletePermanently(fileId);
    }

    const locations = this.locationRepo.findAllByFileId(fileId);
    for (const loc of locations) {
      try {
        const provider = this.providerFactory.getProvider(loc.googleAccountId);
        await provider.deleteFile(loc.providerFileId);

        // Adjust drive used capacity
        const acc = this.accountRepo.findById(loc.googleAccountId);
        if (acc) {
          this.accountRepo.updateCapacity(
            loc.googleAccountId,
            acc.totalSpace,
            Math.max(0, acc.usedSpace - loc.size)
          );
        }
      } catch (err) {
        // Log/continue deleting remaining locations
      }
    }

    return this.fileRepo.deletePermanently(fileId);
  }

  /**
   * Permanently purges all items currently in Trash Bin physically from Google Drive and DB.
   */
  async emptyTrashPhysically(): Promise<number> {
    const trashed = this.fileRepo.findTrashed();
    let count = 0;
    for (const item of trashed) {
      // If parent is also trashed, deleting parent will cascade to child
      const exists = this.fileRepo.findById(item.id);
      if (exists) {
        const deleted = await this.deleteFilePhysically(item.id);
        if (deleted) count++;
      }
    }
    return count;
  }
}
