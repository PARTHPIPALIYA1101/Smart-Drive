import { StorageOperationRepository } from '../../persistence/repositories/storage-operation.repository.js';
import { StorageReservationRepository } from '../../persistence/repositories/storage-reservation.repository.js';
import { FileLocationRepository } from '../../persistence/repositories/file-location.repository.js';
import { FileMigrationRepository } from '../../persistence/repositories/file-migration.repository.js';
import { GoogleAccountRepository } from '../../persistence/repositories/google-account.repository.js';
import { IProviderFactory } from '../../providers/provider-factory.js';
import { StorageOperation } from '../../domain/types.js';
import { RecoveryReport, OperationRecoveryResult } from './recovery.types.js';

export class CrashRecoveryEngine {
  constructor(
    private operationRepo: StorageOperationRepository,
    private reservationRepo: StorageReservationRepository,
    private locationRepo: FileLocationRepository,
    private migrationRepo: FileMigrationRepository,
    private accountRepo: GoogleAccountRepository,
    private providerFactory: IProviderFactory
  ) {}

  /**
   * Scans and recovers all incomplete operations upon startup.
   */
  async reconcileStartupState(): Promise<RecoveryReport> {
    const incompleteOps = this.operationRepo.findIncompleteOperations();
    const results: OperationRecoveryResult[] = [];

    for (const op of incompleteOps) {
      const result = await this.recoverOperation(op);
      results.push(result);
    }

    return {
      recoveredCount: results.length,
      results,
    };
  }

  private async recoverOperation(op: StorageOperation): Promise<OperationRecoveryResult> {
    switch (op.status) {
      case 'RESERVED': {
        // No bytes transferred; release reservations and cancel
        this.reservationRepo.releaseByOperationId(op.id);
        this.operationRepo.updateStatus(op.id, 'CANCELLED', 'CRASH_RECOVERY', 'Cancelled in RESERVED state on restart');
        return {
          operationId: op.id,
          operationType: op.operationType,
          previousStatus: op.status,
          resolution: 'CANCELLED',
          details: 'Released uncommitted capacity reservations',
        };
      }

      case 'EXECUTING': {
        // Transfer was interrupted in flight; inspect destination provider and rollback
        if (op.destDriveId && op.fileId) {
          const copyingLocs = this.locationRepo
            .findAllByFileId(op.fileId)
            .filter((l) => l.status === 'COPYING');

          for (const loc of copyingLocs) {
            try {
              const provider = this.providerFactory.getProvider(loc.googleAccountId);
              await provider.deleteFile(loc.providerFileId);
            } catch {
              // Ignore provider deletion error during cleanup
            }
            this.locationRepo.delete(loc.id);
          }
        }

        this.reservationRepo.releaseByOperationId(op.id);
        this.operationRepo.updateStatus(
          op.id,
          'FAILED',
          'CRASH_DURING_TRANSFER',
          'Interrupted during physical data streaming'
        );

        return {
          operationId: op.id,
          operationType: op.operationType,
          previousStatus: op.status,
          resolution: 'ROLLED_BACK',
          details: 'Cleaned up orphaned destination transfer and released reservations',
        };
      }

      case 'VERIFYING':
      case 'SWITCHING': {
        // Check if destination location reached VERIFIED state and whether file is intact
        if (op.fileId && op.destDriveId) {
          const verifiedLoc = this.locationRepo
            .findAllByFileId(op.fileId)
            .find((l) => l.status === 'VERIFIED');

          const activeLoc = this.locationRepo.findActiveByFileId(op.fileId);

          if (verifiedLoc && activeLoc) {
            try {
              const destProvider = this.providerFactory.getProvider(verifiedLoc.googleAccountId);
              const meta = await destProvider.getFileMetadata(verifiedLoc.providerFileId);

              if (meta.size === activeLoc.size) {
                // Destination file is 100% complete! Finalize the atomic switch
                this.locationRepo.switchActiveLocation(op.fileId, verifiedLoc.id, activeLoc.id);

                // Cleanup old source file
                try {
                  const sourceProvider = this.providerFactory.getProvider(activeLoc.googleAccountId);
                  await sourceProvider.deleteFile(activeLoc.providerFileId);
                  this.locationRepo.delete(activeLoc.id);
                } catch {
                  // Source delete failed, but active pointer committed
                }

                this.reservationRepo.commitByOperationId(op.id);
                this.operationRepo.updateStatus(op.id, 'COMPLETED');

                return {
                  operationId: op.id,
                  operationType: op.operationType,
                  previousStatus: op.status,
                  resolution: 'FINALIZED',
                  details: 'Destination verified complete; finalized atomic switch and cleaned up old source',
                };
              }
            } catch {
              // Destination corrupted or missing
            }

            // If destination was invalid, rollback
            this.locationRepo.delete(verifiedLoc.id);
          }
        }

        this.reservationRepo.releaseByOperationId(op.id);
        this.operationRepo.updateStatus(
          op.id,
          'FAILED',
          'VERIFICATION_ABORTED',
          'Destination incomplete during verification at crash'
        );

        return {
          operationId: op.id,
          operationType: op.operationType,
          previousStatus: op.status,
          resolution: 'ROLLED_BACK',
          details: 'Destination file was incomplete or unverified; preserved original active source',
        };
      }

      default: {
        this.reservationRepo.releaseByOperationId(op.id);
        this.operationRepo.updateStatus(op.id, 'FAILED', 'UNKNOWN_INTERRUPT', 'Interrupted in unhandled state');
        return {
          operationId: op.id,
          operationType: op.operationType,
          previousStatus: op.status,
          resolution: 'CLEANED_UP',
          details: 'Cleaned up unknown in-flight state',
        };
      }
    }
  }
}
