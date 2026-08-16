import { IStorageProvider } from './storage-provider.interface.js';
import { GoogleDriveProvider } from './google-drive/google-drive.provider.js';
import { GoogleOAuthService } from './google-drive/auth/google-oauth.service.js';
import { InMemoryStorageProvider } from './memory/in-memory-storage.provider.js';

export interface IProviderFactory {
  getProvider(accountId: number): IStorageProvider;
  registerMockProvider(accountId: number, provider: IStorageProvider): void;
}

export class StorageProviderFactory implements IProviderFactory {
  private mockProviders = new Map<number, IStorageProvider>();
  private googleProviders = new Map<number, GoogleDriveProvider>();

  constructor(private oauthService?: GoogleOAuthService) {}

  registerMockProvider(accountId: number, provider: IStorageProvider): void {
    this.mockProviders.set(accountId, provider);
  }

  getProvider(accountId: number): IStorageProvider {
    if (this.mockProviders.has(accountId)) {
      return this.mockProviders.get(accountId)!;
    }

    if (!this.oauthService) {
      // Fallback default in-memory provider for testing when no OAuth configured
      const memProvider = new InMemoryStorageProvider();
      this.mockProviders.set(accountId, memProvider);
      return memProvider;
    }

    if (!this.googleProviders.has(accountId)) {
      this.googleProviders.set(accountId, new GoogleDriveProvider(accountId, this.oauthService));
    }

    return this.googleProviders.get(accountId)!;
  }
}
