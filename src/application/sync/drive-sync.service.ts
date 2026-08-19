import { GoogleAccountRepository } from '../../persistence/repositories/google-account.repository.js';
import { IProviderFactory } from '../../providers/provider-factory.js';
import { AccountService } from '../account/account.service.js';
import { CapacityService } from '../../domain/capacity/capacity.service.js';
import { DriveCapacitySnapshot, UnifiedCapacityReport } from '../../domain/capacity/capacity.types.js';
import { EntityNotFoundError } from '../../domain/errors.js';

import { ResourceLimits } from '../../config/resource-limits.js';

export class DriveSyncService {
  constructor(
    private accountRepo: GoogleAccountRepository,
    private providerFactory: IProviderFactory,
    private accountService: AccountService,
    private capacityService: CapacityService
  ) {}

  /**
   * Synchronizes quota information for a single Google Drive account with caching.
   */
  async syncAccountQuota(accountId: number, force = false): Promise<DriveCapacitySnapshot> {
    const account = this.accountRepo.findById(accountId);
    if (!account) {
      throw new EntityNotFoundError('Google Account', accountId);
    }

    const now = Date.now();
    if (!force && account.lastSyncedAt && now - account.lastSyncedAt < ResourceLimits.QUOTA_REFRESH_INTERVAL) {
      return this.capacityService.getDriveCapacitySnapshot(accountId);
    }

    try {
      const provider = this.providerFactory.getProvider(accountId);
      const quota = await provider.getQuota();

      this.accountRepo.updateCapacity(accountId, quota.totalBytes, quota.usedBytes);
      this.accountService.recordSuccess(accountId);

      return this.capacityService.getDriveCapacitySnapshot(accountId);
    } catch (error) {
      this.accountService.recordFailure(accountId);
      throw error;
    }
  }

  /**
   * Synchronizes quota across all registered accounts with failure isolation.
   */
  async syncAllAccounts(force = false): Promise<UnifiedCapacityReport> {
    const accounts = this.accountRepo.listAll();

    // Execute sync across all accounts concurrently
    await Promise.allSettled(
      accounts.map(async (acc) => {
        try {
          await this.syncAccountQuota(acc.id, force);
        } catch {
          // Failure handled inside syncAccountQuota via accountService.recordFailure
        }
      })
    );

    return this.capacityService.getUnifiedCapacityReport();
  }
}
