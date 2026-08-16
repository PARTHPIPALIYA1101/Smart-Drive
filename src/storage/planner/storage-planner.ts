import { CapacityService } from '../../domain/capacity/capacity.service.js';
import { FileRepository } from '../../persistence/repositories/file.repository.js';
import { FileLocationRepository } from '../../persistence/repositories/file-location.repository.js';
import { StorageOperationRepository } from '../../persistence/repositories/storage-operation.repository.js';
import {
  StoragePlan,
  MigrationStep,
  CapacityReservationRequirement,
  RejectedAlternative,
  PlannerOptions,
} from './planner.types.js';
import { InsufficientCapacityError } from '../../domain/errors.js';

interface EvaluatedPlanCandidate {
  targetDriveId: number;
  migrationSteps: MigrationStep[];
  capacityReservations: CapacityReservationRequirement[];
  totalBytesMoved: number;
  migrationsCount: number;
  expectedFinalState: {
    targetDriveUsableAfter: number;
    destinationDrivesUsableAfter: Record<number, number>;
  };
  score: number;
  rationale: string;
}

export class StoragePlanner {
  private static readonly DEFAULT_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours

  constructor(
    private capacityService: CapacityService,
    private fileRepo: FileRepository,
    private locationRepo: FileLocationRepository,
    private operationRepo: StorageOperationRepository
  ) {}

  /**
   * Generates a deterministic StoragePlan for an incoming upload.
   */
  createUploadPlan(requestedBytes: number, options: PlannerOptions = {}): StoragePlan {
    const report = this.capacityService.getUnifiedCapacityReport();
    const cooldownMs = options.cooldownPeriodMs ?? StoragePlanner.DEFAULT_COOLDOWN_MS;
    const now = Date.now();
    const planId = `PLAN-${now}-${Math.floor(Math.random() * 1000)}`;

    const rejectedAlternatives: RejectedAlternative[] = [];

    // Step 1: Direct Placement Check
    const directDrives = report.drives.filter(
      (d) => (d.status === 'AVAILABLE' || d.status === 'DEGRADED') && d.usableSpace >= requestedBytes
    );

    if (directDrives.length > 0) {
      // Pick Drive with maximum usable free space (MAX_USABLE_FREE_SPACE)
      directDrives.sort((a, b) => b.usableSpace - a.usableSpace);
      const selected = directDrives[0];

      for (let i = 1; i < directDrives.length; i++) {
        rejectedAlternatives.push({
          targetDriveId: directDrives[i].accountId,
          targetDriveEmail: directDrives[i].email,
          reason: 'INSUFFICIENT_SPACE',
          details: `Drive has less usable space (${directDrives[i].usableSpace} B) than selected Drive (${selected.usableSpace} B)`,
        });
      }

      // Record non-fitting drives as rejected
      report.drives
        .filter((d) => d.usableSpace < requestedBytes)
        .forEach((d) => {
          rejectedAlternatives.push({
            targetDriveId: d.accountId,
            targetDriveEmail: d.email,
            reason: d.status === 'AVAILABLE' ? 'INSUFFICIENT_SPACE' : 'FAILED_HEALTH',
            details: `Usable space ${d.usableSpace} B is less than requested ${requestedBytes} B`,
          });
        });

      return {
        planId,
        operationType: 'UPLOAD',
        targetDriveId: selected.accountId,
        placementPolicy: 'MAX_USABLE_FREE_SPACE',
        requiresMigration: false,
        score: 10000,
        migrationSteps: [],
        capacityReservations: [
          {
            driveId: selected.accountId,
            reservedBytes: requestedBytes,
            reason: 'INCOMING_UPLOAD',
          },
        ],
        expectedFinalState: {
          targetDriveUsableAfter: selected.usableSpace - requestedBytes,
          destinationDrivesUsableAfter: {},
        },
        rejectedAlternatives,
        rationale: `Direct placement on Drive ${selected.displayName} with ${selected.usableSpace} B usable capacity. Zero migrations required.`,
      };
    }

    // Step 2: Direct placement impossible -> Multi-Drive Rebalance Evaluation
    if (report.totalUsableBytes < requestedBytes) {
      throw new InsufficientCapacityError(
        `Total unified usable storage (${report.totalUsableBytes} B) is insufficient for requested ${requestedBytes} B.`,
        {
          requestedBytes,
          totalUsableBytes: report.totalUsableBytes,
          largestSingleCapacity: report.largestSingleFileCapacity,
        }
      );
    }

    // Get active in-flight operation file IDs to prevent migrating files currently in transfer
    const activeOpFileIds = new Set<number>(
      this.operationRepo
        .findIncompleteOperations()
        .map((op) => op.fileId)
        .filter((id): id is number => id !== null)
    );

    const candidatePlans: EvaluatedPlanCandidate[] = [];

    // Evaluate each candidate target drive T
    const eligibleTargetDrives = report.drives.filter(
      (d) => d.status === 'AVAILABLE' || d.status === 'DEGRADED'
    );

    for (const targetDrive of eligibleTargetDrives) {
      if (targetDrive.migrationLocked) {
        rejectedAlternatives.push({
          targetDriveId: targetDrive.accountId,
          targetDriveEmail: targetDrive.email,
          reason: 'MIGRATION_LOCKED_CANNOT_EVACUATE',
          details: 'Drive is migration-locked and cannot evacuate files to resolve deficit',
        });
        continue;
      }

      const deficit = requestedBytes - targetDrive.usableSpace;

      // Find eligible active files physically located on targetDrive
      const targetLocations = this.locationRepo.findAllByFileId(-1); // helper placeholder or query all
      const allFilesOnTarget = this.getFilesOnDrive(targetDrive.accountId);

      const eligibleFiles = allFilesOnTarget.filter((f) => {
        if (f.lifecycleStatus !== 'ACTIVE') return false;
        if (activeOpFileIds.has(f.id)) return false;
        return true;
      });

      // Pair candidate files with feasible destination drives (other than targetDrive)
      const simulatedDrivesUsable = new Map<number, number>();
      report.drives.forEach((d) => {
        if (d.accountId !== targetDrive.accountId && (d.status === 'AVAILABLE' || d.status === 'DEGRADED')) {
          simulatedDrivesUsable.set(d.accountId, d.usableSpace);
        }
      });

      // Find the smallest combination of files that clears the deficit
      // Heuristic: Sort files descending by size to minimize migration count
      eligibleFiles.sort((a, b) => b.size - a.size);

      const plannedSteps: MigrationStep[] = [];
      let clearedBytes = 0;
      let cooldownPenaltyCount = 0;

      for (const file of eligibleFiles) {
        if (clearedBytes >= deficit) break;

        // Find best destination for this file among available other drives
        let bestDestId: number | null = null;
        let maxDestSpace = -1;

        for (const [destId, availableSpace] of simulatedDrivesUsable.entries()) {
          if (availableSpace >= file.size && availableSpace > maxDestSpace) {
            maxDestSpace = availableSpace;
            bestDestId = destId;
          }
        }

        if (bestDestId !== null) {
          const loc = this.locationRepo.findActiveByFileId(file.id);
          if (loc) {
            plannedSteps.push({
              fileId: file.id,
              filename: file.name,
              sourceDriveId: targetDrive.accountId,
              sourceProviderFileId: loc.providerFileId,
              destinationDriveId: bestDestId,
              fileSizeBytes: file.size,
            });

            clearedBytes += file.size;
            simulatedDrivesUsable.set(bestDestId, maxDestSpace - file.size);

            if (file.updatedAt && now < file.updatedAt + cooldownMs) {
              cooldownPenaltyCount++;
            }
          }
        }
      }

      if (clearedBytes < deficit) {
        rejectedAlternatives.push({
          targetDriveId: targetDrive.accountId,
          targetDriveEmail: targetDrive.email,
          reason: 'NO_FEASIBLE_MIGRATION_DESTINATION',
          details: `Could only clear ${clearedBytes} B of ${deficit} B required deficit`,
        });
        continue;
      }

      // Valid candidate plan constructed
      const totalBytesMoved = plannedSteps.reduce((acc, step) => acc + step.fileSizeBytes, 0);
      const migrationsCount = plannedSteps.length;

      // Scoring formula following priority rules:
      // Base score 1000 - (migrations * 100) - (bytesMovedRatio * 10) - (cooldownPenalties * 50)
      const bytesRatio = totalBytesMoved / requestedBytes;
      const score = 1000 - migrationsCount * 100 - bytesRatio * 10 - cooldownPenaltyCount * 50;

      const destinationDrivesUsableAfter: Record<number, number> = {};
      for (const [destId, spaceAfter] of simulatedDrivesUsable.entries()) {
        destinationDrivesUsableAfter[destId] = spaceAfter;
      }

      const reservations: CapacityReservationRequirement[] = [
        {
          driveId: targetDrive.accountId,
          reservedBytes: requestedBytes,
          reason: 'INCOMING_UPLOAD',
        },
      ];

      plannedSteps.forEach((step) => {
        reservations.push({
          driveId: step.destinationDriveId,
          reservedBytes: step.fileSizeBytes,
          reason: 'MIGRATION_DESTINATION',
        });
      });

      candidatePlans.push({
        targetDriveId: targetDrive.accountId,
        migrationSteps: plannedSteps,
        capacityReservations: reservations,
        totalBytesMoved,
        migrationsCount,
        expectedFinalState: {
          targetDriveUsableAfter: targetDrive.usableSpace + clearedBytes - requestedBytes,
          destinationDrivesUsableAfter,
        },
        score,
        rationale: `Target Drive ${targetDrive.displayName}. Migrating ${migrationsCount} files (${totalBytesMoved} B) to clear ${deficit} B deficit.`,
      });
    }

    if (candidatePlans.length === 0) {
      throw new InsufficientCapacityError(
        `Unable to formulate a safe migration plan for ${requestedBytes} bytes across available drives.`,
        { requestedBytes, rejectedAlternatives }
      );
    }

    // Step 3: Pick candidate plan with highest score
    candidatePlans.sort((a, b) => b.score - a.score);
    const bestPlan = candidatePlans[0];

    return {
      planId,
      operationType: 'UPLOAD',
      targetDriveId: bestPlan.targetDriveId,
      placementPolicy: 'BALANCED_HEURISTIC',
      requiresMigration: true,
      score: bestPlan.score,
      migrationSteps: bestPlan.migrationSteps,
      capacityReservations: bestPlan.capacityReservations,
      expectedFinalState: bestPlan.expectedFinalState,
      rejectedAlternatives,
      rationale: bestPlan.rationale,
    };
  }

  private getFilesOnDrive(accountId: number) {
    const allFiles = this.fileRepo.findActiveByParentId(null);
    // Recursively collect all active files
    const result: Array<{ id: number; name: string; size: number; lifecycleStatus: string; updatedAt: number }> = [];

    const checkNode = (nodeId: number) => {
      const loc = this.locationRepo.findActiveByFileId(nodeId);
      if (loc && loc.googleAccountId === accountId) {
        const file = this.fileRepo.findById(nodeId);
        if (file && !file.isFolder) {
          result.push(file);
        }
      }

      const children = this.fileRepo.findActiveByParentId(nodeId);
      for (const child of children) {
        checkNode(child.id);
      }
    };

    allFiles.forEach((f) => checkNode(f.id));
    return result;
  }
}
