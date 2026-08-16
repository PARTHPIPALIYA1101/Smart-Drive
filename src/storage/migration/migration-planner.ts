import { CapacityService } from '../../domain/capacity/capacity.service.js';
import { FileRepository } from '../../persistence/repositories/file.repository.js';
import { FileLocationRepository } from '../../persistence/repositories/file-location.repository.js';
import { GoogleAccountRepository } from '../../persistence/repositories/google-account.repository.js';
import { StorageOperationRepository } from '../../persistence/repositories/storage-operation.repository.js';
import {
  EvacuationPlan,
  ManualMigrationPlan,
} from './migration.types.js';
import {
  MigrationStep,
  CapacityReservationRequirement,
} from '../planner/planner.types.js';
import { MigrationReason, SmartFile } from '../../domain/types.js';
import {
  EntityNotFoundError,
  InsufficientCapacityError,
  DriveUnavailableError,
} from '../../domain/errors.js';

export class MigrationPlanner {
  constructor(
    private capacityService: CapacityService,
    private fileRepo: FileRepository,
    private locationRepo: FileLocationRepository,
    private accountRepo: GoogleAccountRepository,
    private operationRepo: StorageOperationRepository
  ) {}

  /**
   * Plans the complete evacuation of all files from a retiring/evacuating Drive.
   */
  planDriveEvacuation(
    sourceDriveId: number,
    reason: MigrationReason = 'DRIVE_RETIREMENT'
  ): EvacuationPlan {
    const sourceAccount = this.accountRepo.findById(sourceDriveId);
    if (!sourceAccount) {
      throw new EntityNotFoundError('Google Account', sourceDriveId);
    }

    const report = this.capacityService.getUnifiedCapacityReport();
    const filesOnSource = this.getFilesOnDrive(sourceDriveId);

    // Filter destination drives: must be available/degraded and not the source drive
    const destDrivesUsable = new Map<number, number>();
    report.drives.forEach((d) => {
      if (d.accountId !== sourceDriveId && (d.status === 'AVAILABLE' || d.status === 'DEGRADED')) {
        destDrivesUsable.set(d.accountId, d.usableSpace);
      }
    });

    // Sort files descending by size for greedy bin packing
    filesOnSource.sort((a, b) => b.size - a.size);

    const migrationSteps: MigrationStep[] = [];
    const unmigratableFiles: Array<{ fileId: number; filename: string; size: number; reason: string }> = [];
    const reservations: CapacityReservationRequirement[] = [];
    let totalBytesToTransfer = 0;

    for (const file of filesOnSource) {
      const loc = this.locationRepo.findActiveByFileId(file.id);
      if (!loc) {
        unmigratableFiles.push({
          fileId: file.id,
          filename: file.name,
          size: file.size,
          reason: 'No active physical location record found',
        });
        continue;
      }

      // Find destination drive with most usable space that can fit the file
      let bestDestId: number | null = null;
      let maxAvailable = -1;

      for (const [destId, space] of destDrivesUsable.entries()) {
        if (space >= file.size && space > maxAvailable) {
          maxAvailable = space;
          bestDestId = destId;
        }
      }

      if (bestDestId !== null) {
        migrationSteps.push({
          fileId: file.id,
          filename: file.name,
          sourceDriveId,
          sourceProviderFileId: loc.providerFileId,
          destinationDriveId: bestDestId,
          fileSizeBytes: file.size,
        });

        reservations.push({
          driveId: bestDestId,
          reservedBytes: file.size,
          reason: 'MIGRATION_DESTINATION',
        });

        totalBytesToTransfer += file.size;
        destDrivesUsable.set(bestDestId, maxAvailable - file.size);
      } else {
        unmigratableFiles.push({
          fileId: file.id,
          filename: file.name,
          size: file.size,
          reason: 'No available destination drive has sufficient capacity to store complete file',
        });
      }
    }

    const planId = `EVAC-${Date.now()}-${sourceDriveId}`;

    return {
      planId,
      sourceDriveId,
      reason,
      migrationSteps,
      unmigratableFiles,
      totalBytesToTransfer,
      capacityReservations: reservations,
      isFullyEvacuatable: unmigratableFiles.length === 0,
    };
  }

  /**
   * Formulates a single file manual migration plan.
   */
  planSingleFileMigration(fileId: number, targetDriveId: number): ManualMigrationPlan {
    const file = this.fileRepo.findById(fileId);
    if (!file || file.isFolder) {
      throw new EntityNotFoundError('File', fileId);
    }

    if (file.lifecycleStatus !== 'ACTIVE') {
      throw new Error(`File ${file.name} is not in ACTIVE state (status: ${file.lifecycleStatus})`);
    }

    const activeLoc = this.locationRepo.findActiveByFileId(fileId);
    if (!activeLoc) {
      throw new EntityNotFoundError('Active file location for file', fileId);
    }

    if (activeLoc.googleAccountId === targetDriveId) {
      throw new Error(`File ${file.name} is already stored on target Drive ID ${targetDriveId}`);
    }

    const targetAccount = this.accountRepo.findById(targetDriveId);
    if (!targetAccount) {
      throw new EntityNotFoundError('Google Account', targetDriveId);
    }

    if (targetAccount.status !== 'AVAILABLE' && targetAccount.status !== 'DEGRADED') {
      throw new DriveUnavailableError(
        `Target Drive ${targetAccount.displayName} is ${targetAccount.status}`
      );
    }

    const snapshot = this.capacityService.getDriveCapacitySnapshot(targetDriveId);
    if (snapshot.usableSpace < file.size) {
      throw new InsufficientCapacityError(
        `Target Drive ${targetAccount.displayName} does not have sufficient capacity for ${file.size} B (Usable: ${snapshot.usableSpace} B).`,
        { requestedBytes: file.size, usableSpace: snapshot.usableSpace }
      );
    }

    const planId = `MIG-${Date.now()}-${fileId}`;

    return {
      planId,
      fileId,
      filename: file.name,
      sourceDriveId: activeLoc.googleAccountId,
      sourceProviderFileId: activeLoc.providerFileId,
      destinationDriveId: targetDriveId,
      fileSizeBytes: file.size,
      capacityReservation: {
        driveId: targetDriveId,
        reservedBytes: file.size,
        reason: 'MIGRATION_DESTINATION',
      },
    };
  }

  private getFilesOnDrive(accountId: number): SmartFile[] {
    const allRootNodes = this.fileRepo.findActiveByParentId(null);
    const filesList: SmartFile[] = [];

    const traverse = (nodeId: number) => {
      const node = this.fileRepo.findById(nodeId);
      if (node && !node.isFolder) {
        const loc = this.locationRepo.findActiveByFileId(node.id);
        if (loc && loc.googleAccountId === accountId) {
          filesList.push(node);
        }
      }

      const children = this.fileRepo.findActiveByParentId(nodeId);
      for (const child of children) {
        traverse(child.id);
      }
    };

    allRootNodes.forEach((n) => traverse(n.id));
    return filesList;
  }
}
