import { FileRepository } from '../../persistence/repositories/file.repository.js';
import { FileLocationRepository } from '../../persistence/repositories/file-location.repository.js';
import { GoogleAccountRepository } from '../../persistence/repositories/google-account.repository.js';
import { StorageOperationRepository } from '../../persistence/repositories/storage-operation.repository.js';
import { FileMigrationRepository } from '../../persistence/repositories/file-migration.repository.js';
import { ReservationManager } from '../reservation/reservation-manager.js';
import { IProviderFactory } from '../../providers/provider-factory.js';
import { IntegrityVerifier } from '../integrity/integrity-verifier.js';
import { MigrationStep, StoragePlan } from '../planner/planner.types.js';
import { EvacuationPlan, ManualMigrationPlan } from './migration.types.js';
import { FileMigration, MigrationReason, StorageOperation } from '../../domain/types.js';
import { EntityNotFoundError, SmartDriveError } from '../../domain/errors.js';
import { Readable } from 'node:stream';

export class MigrationExecutor {
  constructor(
    private fileRepo: FileRepository,
    private locationRepo: FileLocationRepository,
    private accountRepo: GoogleAccountRepository,
    private operationRepo: StorageOperationRepository,
    private migrationRepo: FileMigrationRepository,
    private reservationManager: ReservationManager,
    private providerFactory: IProviderFactory
  ) {}

  /**
   * Executes a single safe migration step following the Copy -> Verify -> Switch -> Cleanup state machine.
   */
  async executeMigrationStep(
    step: MigrationStep,
    operationId: string,
    reason: MigrationReason = 'CAPACITY_REBALANCE'
  ): Promise<FileMigration> {
    const file = this.fileRepo.findById(step.fileId);
    if (!file) {
      throw new EntityNotFoundError('File', step.fileId);
    }

    const sourceLoc = this.locationRepo.findActiveByFileId(step.fileId);
    if (!sourceLoc) {
      throw new EntityNotFoundError('Active location for file', step.fileId);
    }

    const now = Date.now();

    // Ensure operation journal row exists
    const existingOp = this.operationRepo.findById(operationId);
    if (!existingOp) {
      this.operationRepo.insert({
        id: operationId,
        operationType: 'PHYSICAL_MIGRATE',
        fileId: step.fileId,
        sourceDriveId: step.sourceDriveId,
        destDriveId: step.destinationDriveId,
        requestedBytes: step.fileSizeBytes,
        status: 'EXECUTING',
        createdAt: now,
      });
    }

    // 1. Record migration in database
    const migrationRecord = this.migrationRepo.insert({
      operationId,
      fileId: step.fileId,
      sourceDriveId: step.sourceDriveId,
      sourceProviderFileId: step.sourceProviderFileId,
      destDriveId: step.destinationDriveId,
      reason,
      bytesTransferred: 0,
      status: 'IN_PROGRESS',
      startedAt: now,
    });

    // 2. Insert destination file_locations in COPYING state
    const destLoc = this.locationRepo.insert({
      fileId: step.fileId,
      googleAccountId: step.destinationDriveId,
      providerFileId: 'pending-copy',
      status: 'COPYING',
      size: step.fileSizeBytes,
      mimeType: sourceLoc.mimeType,
      createdAt: now,
    });

    let destProviderFileMetadata;
    const destProvider = this.providerFactory.getProvider(step.destinationDriveId);
    const sourceProvider = this.providerFactory.getProvider(step.sourceDriveId);

    try {
      // 3. COPY: Stream from source provider -> destination provider
      if (step.sourceDriveId === step.destinationDriveId && destProvider.serverSideCopy) {
        destProviderFileMetadata = await destProvider.serverSideCopy(
          step.sourceProviderFileId,
          step.filename
        );
      } else {
        const downloadStream = await sourceProvider.downloadStream(step.sourceProviderFileId);
        destProviderFileMetadata = await destProvider.uploadStream(downloadStream, {
          filename: step.filename,
          mimeType: sourceLoc.mimeType,
          size: step.fileSizeBytes,
        });
      }

      // 4. Update destination location in DB
      this.locationRepo.updateStatus(destLoc.id, 'VERIFIED');
      this.migrationRepo.updateStatus(
        migrationRecord.id,
        'VERIFIED',
        destProviderFileMetadata.size,
        destProviderFileMetadata.providerFileId
      );

      // 5. VERIFY: Confirm size & checksum integrity
      IntegrityVerifier.verify(
        {
          size: sourceLoc.size,
          checksum: sourceLoc.checksum,
          checksumType: sourceLoc.checksumType,
        },
        destProviderFileMetadata
      );

      // Update provider_file_id and checksum on destination location before switching
      this.locationRepo.updateProviderMetadata(
        destLoc.id,
        destProviderFileMetadata.providerFileId,
        destProviderFileMetadata.checksum,
        destProviderFileMetadata.checksumType
      );

      // 6. ATOMIC SWITCH: Microsecond DB transaction
      this.locationRepo.switchActiveLocation(step.fileId, destLoc.id, sourceLoc.id);
    } catch (migrationError) {
      // Safe Rollback: Clean up partial destination on provider and DB
      if (destProviderFileMetadata?.providerFileId) {
        try {
          await destProvider.deleteFile(destProviderFileMetadata.providerFileId);
        } catch {
          // Ignore delete error during rollback
        }
      }
      this.locationRepo.delete(destLoc.id);
      this.migrationRepo.updateStatus(migrationRecord.id, 'FAILED');
      throw migrationError;
    }

    // 7. CLEANUP: Delete physical source copy on source provider
    try {
      await sourceProvider.deleteFile(step.sourceProviderFileId);
      this.locationRepo.delete(sourceLoc.id);
    } catch (cleanupErr) {
      // Source cleanup failure does not invalidate completed migration
    }

    // 8. Update database drive quotas
    const sourceAcc = this.accountRepo.findById(step.sourceDriveId);
    if (sourceAcc) {
      this.accountRepo.updateCapacity(
        step.sourceDriveId,
        sourceAcc.totalSpace,
        Math.max(0, sourceAcc.usedSpace - step.fileSizeBytes)
      );
    }

    const destAcc = this.accountRepo.findById(step.destinationDriveId);
    if (destAcc) {
      this.accountRepo.updateCapacity(
        step.destinationDriveId,
        destAcc.totalSpace,
        destAcc.usedSpace + step.fileSizeBytes
      );
    }

    const completed = this.migrationRepo.updateStatus(migrationRecord.id, 'COMPLETED')!;
    return completed;
  }

  /**
   * Executes a complete StoragePlan including required pre-upload migrations.
   */
  async executeStoragePlan(
    plan: StoragePlan,
    uploadStreamPayload?: { name: string; parentId: number | null; mimeType: string; size: number; stream: Readable }
  ): Promise<StorageOperation> {
    const opId = `OP-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const now = Date.now();

    // 1. Create Operation Journal Row
    this.operationRepo.insert({
      id: opId,
      operationType: plan.operationType,
      destDriveId: plan.targetDriveId,
      requestedBytes: uploadStreamPayload?.size ?? 0,
      status: 'EXECUTING',
      planContext: JSON.stringify(plan),
      createdAt: now,
    });

    try {
      // 2. Reserve destination drives for pre-upload migration steps
      const migrationPlan: StoragePlan = {
        ...plan,
        capacityReservations: plan.capacityReservations.filter(
          (r) => r.reason === 'MIGRATION_DESTINATION'
        ),
      };

      if (migrationPlan.capacityReservations.length > 0) {
        this.reservationManager.acquirePlanReservations(migrationPlan, opId);
      }

      // 3. Execute all pre-upload migration steps (freeing space on target drive)
      for (const step of plan.migrationSteps) {
        await this.executeMigrationStep(step, opId, 'CAPACITY_REBALANCE');
      }

      // 4. Reserve target drive for incoming upload now that target space is freed
      const uploadPlan: StoragePlan = {
        ...plan,
        capacityReservations: plan.capacityReservations.filter(
          (r) => r.reason === 'INCOMING_UPLOAD'
        ),
      };

      if (uploadPlan.capacityReservations.length > 0) {
        this.reservationManager.acquirePlanReservations(uploadPlan, opId);
      }

      // 5. If upload payload is provided, stream to target drive
      if (uploadStreamPayload) {
        const targetProvider = this.providerFactory.getProvider(plan.targetDriveId);
        const uploadMeta = await targetProvider.uploadStream(uploadStreamPayload.stream, {
          filename: uploadStreamPayload.name,
          mimeType: uploadStreamPayload.mimeType,
          size: uploadStreamPayload.size,
        });

        const file = this.fileRepo.insert({
          name: uploadStreamPayload.name,
          parentId: uploadStreamPayload.parentId,
          isFolder: false,
          mimeType: uploadMeta.mimeType,
          size: uploadMeta.size,
          lifecycleStatus: 'ACTIVE',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });

        this.locationRepo.insert({
          fileId: file.id,
          googleAccountId: plan.targetDriveId,
          providerFileId: uploadMeta.providerFileId,
          status: 'ACTIVE',
          size: uploadMeta.size,
          mimeType: uploadMeta.mimeType,
          checksum: uploadMeta.checksum,
          checksumType: uploadMeta.checksumType,
          createdAt: Date.now(),
        });

        const targetAcc = this.accountRepo.findById(plan.targetDriveId);
        if (targetAcc) {
          this.accountRepo.updateCapacity(
            plan.targetDriveId,
            targetAcc.totalSpace,
            targetAcc.usedSpace + uploadMeta.size
          );
        }
      }

      // 6. Commit all reservations and mark operation COMPLETED
      this.reservationManager.commitPlanReservations(opId);
      return this.operationRepo.updateStatus(opId, 'COMPLETED')!;
    } catch (executionError) {
      this.reservationManager.releasePlanReservations(opId);
      this.operationRepo.updateStatus(
        opId,
        'FAILED',
        'EXECUTION_FAILED',
        executionError instanceof Error ? executionError.message : 'Unknown execution error'
      );
      throw executionError;
    }
  }

  /**
   * Executes a full Drive Evacuation plan.
   */
  async executeEvacuationPlan(plan: EvacuationPlan): Promise<FileMigration[]> {
    const opId = `OP-EVAC-${Date.now()}-${plan.sourceDriveId}`;
    const now = Date.now();

    this.operationRepo.insert({
      id: opId,
      operationType: 'DRIVE_RETIRE',
      sourceDriveId: plan.sourceDriveId,
      requestedBytes: plan.totalBytesToTransfer,
      status: 'EXECUTING',
      planContext: JSON.stringify(plan),
      createdAt: now,
    });

    const completedMigrations: FileMigration[] = [];

    for (const step of plan.migrationSteps) {
      const migration = await this.executeMigrationStep(step, opId, plan.reason);
      completedMigrations.push(migration);
    }

    this.operationRepo.updateStatus(opId, 'COMPLETED');
    return completedMigrations;
  }
}
