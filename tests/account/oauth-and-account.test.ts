import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createDatabaseConnection, DatabaseConnection } from '../../src/persistence/db.js';
import { runMigrations } from '../../src/persistence/migrate.js';
import { GoogleAccountRepository } from '../../src/persistence/repositories/google-account.repository.js';
import { GoogleOAuthService } from '../../src/providers/google-drive/auth/google-oauth.service.js';
import { AccountService } from '../../src/application/account/account.service.js';
import { TokenEncryptor } from '../../src/infrastructure/crypto/token-encryptor.js';

describe('OAuth & Account Management Suite', () => {
  let conn: DatabaseConnection;
  let accountRepo: GoogleAccountRepository;
  let encryptor: TokenEncryptor;
  let oauthService: GoogleOAuthService;
  let accountService: AccountService;

  const mockConfig = {
    clientId: 'mock-client-id.apps.googleusercontent.com',
    clientSecret: 'mock-client-secret',
    redirectUri: 'http://localhost:3000/api/auth/google/callback',
  };

  beforeEach(() => {
    conn = createDatabaseConnection(':memory:');
    runMigrations(conn);

    accountRepo = new GoogleAccountRepository(conn.db);
    encryptor = new TokenEncryptor();
    oauthService = new GoogleOAuthService(mockConfig, encryptor, accountRepo);
    accountService = new AccountService(accountRepo, oauthService, encryptor);
  });

  afterEach(() => {
    conn.close();
    vi.restoreAllMocks();
  });

  describe('GoogleOAuthService', () => {
    it('generates proper authorization URLs with offline access and scopes', () => {
      const authUrl = oauthService.generateAuthUrl('custom-state');
      const url = new URL(authUrl);

      expect(url.origin).toBe('https://accounts.google.com');
      expect(url.pathname).toBe('/o/oauth2/v2/auth');
      expect(url.searchParams.get('client_id')).toBe(mockConfig.clientId);
      expect(url.searchParams.get('access_type')).toBe('offline');
      expect(url.searchParams.get('state')).toBe('custom-state');
      expect(url.searchParams.get('scope')).toContain('drive');
    });

    it('exchanges code and retrieves user tokens', async () => {
      // Mock global fetch for token exchange and userinfo
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            access_token: 'mock-access-token',
            refresh_token: 'mock-refresh-token',
            expires_in: 3600,
            token_type: 'Bearer',
          }),
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            id: 'google-user-123',
            email: 'user1@gmail.com',
            name: 'Test User',
          }),
        } as any);

      const result = await oauthService.exchangeCode('mock-auth-code');
      expect(result.tokens.accessToken).toBe('mock-access-token');
      expect(result.tokens.refreshToken).toBe('mock-refresh-token');
      expect(result.profile.email).toBe('user1@gmail.com');
    });
  });

  describe('AccountService Lifecycle', () => {
    it('connects a new Google account and persists encrypted tokens', async () => {
      vi.spyOn(oauthService, 'exchangeCode').mockResolvedValue({
        tokens: {
          accessToken: 'initial-access-token',
          refreshToken: 'initial-refresh-token',
          expiresAt: Date.now() + 3600000,
        },
        profile: {
          id: 'google-1',
          email: 'alice@gmail.com',
          name: 'Alice Cooper',
        },
      });

      const account = await accountService.connectAccount('auth-code-1');
      expect(account.id).toBeDefined();
      expect(account.email).toBe('alice@gmail.com');
      expect(account.displayName).toBe('Alice Cooper');
      expect(account.status).toBe('AVAILABLE');

      // Credentials in DB must be encrypted, not plaintext
      const inDb = accountRepo.findById(account.id);
      expect(inDb?.encryptedCredentials).not.toContain('initial-access-token');

      // Decryption works
      const decrypted = JSON.parse(encryptor.decrypt(inDb!.encryptedCredentials));
      expect(decrypted.accessToken).toBe('initial-access-token');
    });

    it('reconnecting an existing account updates credentials without duplicates', async () => {
      vi.spyOn(oauthService, 'exchangeCode').mockResolvedValue({
        tokens: {
          accessToken: 'token-v1',
          refreshToken: 'refresh-v1',
          expiresAt: Date.now() + 3600000,
        },
        profile: {
          id: 'google-1',
          email: 'bob@gmail.com',
          name: 'Bob Marley',
        },
      });

      await accountService.connectAccount('code-1');
      expect(accountService.listAccounts()).toHaveLength(1);

      // Reconnect with new token
      vi.spyOn(oauthService, 'exchangeCode').mockResolvedValue({
        tokens: {
          accessToken: 'token-v2',
          refreshToken: 'refresh-v2',
          expiresAt: Date.now() + 3600000,
        },
        profile: {
          id: 'google-1',
          email: 'bob@gmail.com',
          name: 'Bob Marley',
        },
      });

      const reconnected = await accountService.connectAccount('code-2');
      expect(accountService.listAccounts()).toHaveLength(1);

      const decrypted = JSON.parse(encryptor.decrypt(reconnected.encryptedCredentials));
      expect(decrypted.accessToken).toBe('token-v2');
    });

    it('tracks circuit breaker state transitions (AVAILABLE -> DEGRADED -> UNAVAILABLE -> AVAILABLE)', () => {
      const now = Date.now();
      const account = accountRepo.insert({
        email: 'charlie@gmail.com',
        displayName: 'Charlie',
        totalSpace: 1000,
        usedSpace: 0,
        freeSpace: 1000,
        reservedBytes: 0,
        migrationLocked: false,
        status: 'AVAILABLE',
        encryptedCredentials: encryptor.encrypt('{}'),
        consecutiveFailures: 0,
        createdAt: now,
        updatedAt: now,
      });

      // 1-2 failures: remains AVAILABLE
      accountService.recordFailure(account.id);
      accountService.recordFailure(account.id);
      expect(accountService.getAccount(account.id).status).toBe('AVAILABLE');

      // 3 failures: transitions to DEGRADED
      accountService.recordFailure(account.id);
      expect(accountService.getAccount(account.id).status).toBe('DEGRADED');

      // 5 failures: transitions to UNAVAILABLE
      accountService.recordFailure(account.id);
      accountService.recordFailure(account.id);
      expect(accountService.getAccount(account.id).status).toBe('UNAVAILABLE');

      // Success restores to AVAILABLE
      accountService.recordSuccess(account.id);
      expect(accountService.getAccount(account.id).status).toBe('AVAILABLE');
    });

    it('manages migration locks and reserved space settings', () => {
      const now = Date.now();
      const account = accountRepo.insert({
        email: 'dave@gmail.com',
        displayName: 'Dave',
        totalSpace: 10000,
        usedSpace: 0,
        freeSpace: 10000,
        reservedBytes: 0,
        migrationLocked: false,
        status: 'AVAILABLE',
        encryptedCredentials: encryptor.encrypt('{}'),
        consecutiveFailures: 0,
        createdAt: now,
        updatedAt: now,
      });

      accountService.setMigrationLock(account.id, true);
      expect(accountService.getAccount(account.id).migrationLocked).toBe(true);

      accountService.setReservedBytes(account.id, 2000);
      expect(accountService.getAccount(account.id).reservedBytes).toBe(2000);
    });
  });
});
