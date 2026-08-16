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
} from './transfer.types.js';
import {
  EntityNotFoundError,
  InsufficientCapacityError,
  DriveUnavailableError,
} from '../errors.js';
import { DuplicateSiblingError, InvalidParentError } from '../vfs/vfs.service.js';

export class TransferService {
  constructor(
    private fileRepo: FileRepository,
    private locationRepo: FileLocationRepository,
    private accountRepo: GoogleAccountRepository,
    private operationRepo: StorageOperationRepository,
    private reservationRepo: StorageReservationRepository,
    private capacityService: CapacityService,
    private providerFactory: IProviderFactory,
    private eventBus?: DomainEventBus
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
   * Uploads a file via direct placement (selecting the Drive with MAX_USABLE_FREE_SPACE).
   */
  async uploadFile(input: UploadFileInput): Promise<FileTransferResult> {
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
        // Safe retry / skip: if identical active file exists, return it
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
          file: existingSibling,
          location: loc || ({} as any),
          operation: op,
          skipped: true,
        };
      } else if (conflictAction === 'REPLACE') {
        // Physically delete existing file before uploading replacement
        await this.deleteFilePhysically(existingSibling.id);
      } else if (conflictAction === 'RENAME') {
        // Generate non-conflicting name (e.g. filename (1).ext)
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

    // Pick Drive with maximum usable free space
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

    this.operationRepo.updateStatus(opId, 'EXECUTING');
    this.eventBus?.publish('UPLOAD_PROGRESS', { operationId: opId, status: 'EXECUTING', filename: validName });

    // 5. Execute Physical Upload Stream
    let providerFileMetadata;
    try {
      const provider = this.providerFactory.getProvider(selectedDrive.accountId);
      providerFileMetadata = await provider.uploadStream(input.stream, {
        filename: validName,
        mimeType: input.mimeType,
        size: input.size,
      });
    } catch (uploadError) {
      // Rollback on upload failure
      this.reservationRepo.releaseByOperationId(opId);
      const errMsg = uploadError instanceof Error ? uploadError.message : 'Unknown upload error';
      this.operationRepo.updateStatus(
        opId,
        'FAILED',
        'UPLOAD_FAILED',
        errMsg
      );
      this.eventBus?.publish('UPLOAD_FAILED', { operationId: opId, error: errMsg });
      throw uploadError;
    }

    // 6. Record in Virtual Filesystem & Physical Locations
    const file = this.fileRepo.insert({
      name: validName,
      parentId: normParentId,
      isFolder: false,
      mimeType: providerFileMetadata.mimeType,
      size: providerFileMetadata.size,
      lifecycleStatus: 'ACTIVE',
      createdAt: now,
      updatedAt: now,
    });

    const location = this.locationRepo.insert({
      fileId: file.id,
      googleAccountId: selectedDrive.accountId,
      providerFileId: providerFileMetadata.providerFileId,
      status: 'ACTIVE',
      size: providerFileMetadata.size,
      mimeType: providerFileMetadata.mimeType,
      checksum: providerFileMetadata.checksum,
      checksumType: providerFileMetadata.checksumType,
      createdAt: now,
    });

    // 7. Update Drive Quota in DB & Commit Reservation
    const driveAcc = this.accountRepo.findById(selectedDrive.accountId);
    if (driveAcc) {
      this.accountRepo.updateCapacity(
        selectedDrive.accountId,
        driveAcc.totalSpace,
        driveAcc.usedSpace + providerFileMetadata.size
      );
      this.eventBus?.publish('DRIVE_QUOTA_UPDATED', { accountId: selectedDrive.accountId });
    }

    this.reservationRepo.commitByOperationId(opId);
    const completedOp = this.operationRepo.updateStatus(opId, 'COMPLETED')!;

    this.eventBus?.publish('FILE_CREATED', file);
    this.eventBus?.publish('UPLOAD_COMPLETED', { file, location, operation: completedOp });

    return {
      file,
      location,
      operation: completedOp,
    };
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
