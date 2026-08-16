import { GoogleAccount } from '../../domain/types.js';
import { GoogleAccountRepository } from '../../persistence/repositories/google-account.repository.js';
import { GoogleOAuthService } from '../../providers/google-drive/auth/google-oauth.service.js';
import { ITokenEncryptor } from '../../infrastructure/crypto/token-encryptor.js';
import { EntityNotFoundError } from '../../domain/errors.js';
import { DomainEventBus } from '../../domain/events/event-bus.js';

export class AccountService {
  private static readonly DEGRADED_THRESHOLD = 3;
  private static readonly UNAVAILABLE_THRESHOLD = 5;

  constructor(
    private accountRepo: GoogleAccountRepository,
    private oauthService: GoogleOAuthService,
    private encryptor: ITokenEncryptor,
    private eventBus?: DomainEventBus
  ) {}

  /**
   * Completes OAuth connection flow by authorization code.
   */
  async connectAccount(code: string): Promise<GoogleAccount> {
    const { tokens, profile } = await this.oauthService.exchangeCode(code);
    const encryptedCredentials = this.encryptor.encrypt(JSON.stringify(tokens));

    const existing = this.accountRepo.findByEmail(profile.email);
    const now = Date.now();

    if (existing) {
      // Reconnection of existing account
      this.accountRepo.updateCredentials(existing.id, encryptedCredentials);
      this.accountRepo.updateStatus(existing.id, 'AVAILABLE');

      const updated = this.accountRepo.findById(existing.id);
      if (!updated) {
        throw new EntityNotFoundError('Google Account', existing.id);
      }
      this.eventBus?.publish('DRIVE_STATUS_CHANGED', updated);
      return updated;
    }

    // New Google Drive account registration
    const newAccount = this.accountRepo.insert({
      email: profile.email,
      displayName: profile.name || profile.email,
      totalSpace: 0,
      usedSpace: 0,
      freeSpace: 0,
      reservedBytes: 0,
      migrationLocked: false,
      status: 'AVAILABLE',
      encryptedCredentials,
      consecutiveFailures: 0,
      createdAt: now,
      updatedAt: now,
    });

    this.eventBus?.publish('DRIVE_STATUS_CHANGED', newAccount);
    return newAccount;
  }

  listAccounts(): GoogleAccount[] {
    return this.accountRepo.listAll();
  }

  listAvailableAccounts(): GoogleAccount[] {
    return this.accountRepo.listAvailable();
  }

  getAccount(id: number): GoogleAccount {
    const account = this.accountRepo.findById(id);
    if (!account) {
      throw new EntityNotFoundError('Google Account', id);
    }
    return account;
  }

  setMigrationLock(id: number, locked: boolean): GoogleAccount {
    const account = this.accountRepo.setMigrationLock(id, locked);
    if (!account) {
      throw new EntityNotFoundError('Google Account', id);
    }
    this.eventBus?.publish('DRIVE_STATUS_CHANGED', account);
    return account;
  }

  setReservedBytes(id: number, reservedBytes: number): GoogleAccount {
    if (reservedBytes < 0) {
      throw new Error('Reserved bytes must be non-negative');
    }
    const account = this.accountRepo.setReservedBytes(id, reservedBytes);
    if (!account) {
      throw new EntityNotFoundError('Google Account', id);
    }
    this.eventBus?.publish('DRIVE_STATUS_CHANGED', account);
    return account;
  }

  disconnectAccount(id: number): boolean {
    const account = this.accountRepo.findById(id);
    if (!account) {
      throw new EntityNotFoundError('Google Account', id);
    }
    const res = this.accountRepo.delete(id);
    if (res) {
      this.eventBus?.publish('DRIVE_STATUS_CHANGED', { id, disconnected: true });
    }
    return res;
  }

  recordFailure(id: number): void {
    const account = this.accountRepo.findById(id);
    if (!account) return;

    const failures = account.consecutiveFailures + 1;
    let newStatus = account.status;

    if (failures >= AccountService.UNAVAILABLE_THRESHOLD) {
      newStatus = 'UNAVAILABLE';
    } else if (failures >= AccountService.DEGRADED_THRESHOLD) {
      newStatus = 'DEGRADED';
    }

    this.accountRepo.recordFailure(id, newStatus, failures);
    this.eventBus?.publish('DRIVE_STATUS_CHANGED', { id, status: newStatus, failures });
  }

  recordSuccess(id: number): void {
    this.accountRepo.recordSuccess(id);
  }
}
