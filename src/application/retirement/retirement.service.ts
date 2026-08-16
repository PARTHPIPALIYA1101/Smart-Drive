import { GoogleAccountRepository } from '../../persistence/repositories/google-account.repository.js';
import { MigrationPlanner } from '../../storage/migration/migration-planner.js';
import { MigrationExecutor } from '../../storage/migration/migration-executor.js';
import { EntityNotFoundError, InsufficientCapacityError } from '../../domain/errors.js';

export class DriveRetirementService {
  constructor(
    private accountRepo: GoogleAccountRepository,
    private migrationPlanner: MigrationPlanner,
    private migrationExecutor: MigrationExecutor
  ) {}

  /**
   * Orchestrates the safe retirement and disconnection of a Google Drive account.
   * Evacuates all active files to other healthy drives before disconnecting.
   */
  async retireDrive(accountId: number): Promise<{ success: boolean; migratedCount: number; message: string }> {
    const account = this.accountRepo.findById(accountId);
    if (!account) {
      throw new EntityNotFoundError('Google Account', accountId);
    }

    // 1. Lock drive to prevent new incoming uploads during retirement
    this.accountRepo.setMigrationLock(accountId, true);
    this.accountRepo.updateStatus(accountId, 'DEGRADED');

    // 2. Generate Evacuation Plan
    const plan = this.migrationPlanner.planDriveEvacuation(accountId, 'DRIVE_RETIREMENT');

    if (!plan.isFullyEvacuatable) {
      // Revert status and abort
      this.accountRepo.setMigrationLock(accountId, false);
      this.accountRepo.updateStatus(accountId, 'AVAILABLE');

      throw new InsufficientCapacityError(
        `Cannot retire Drive ${account.displayName}: other connected drives have insufficient capacity to store all complete files.`,
        { unmigratableFiles: plan.unmigratableFiles }
      );
    }

    // 3. Execute all migrations
    const migrations = await this.migrationExecutor.executeEvacuationPlan(plan);

    // 4. Mark account DISCONNECTED
    this.accountRepo.updateStatus(accountId, 'DISCONNECTED');

    return {
      success: true,
      migratedCount: migrations.length,
      message: `Drive ${account.displayName} successfully retired. ${migrations.length} files migrated to other connected drives.`,
    };
  }
}
