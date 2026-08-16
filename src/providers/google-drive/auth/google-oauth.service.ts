import { GoogleOAuthConfig, GoogleUserProfile, OAuthTokens } from './oauth.types.js';
import { ITokenEncryptor } from '../../../infrastructure/crypto/token-encryptor.js';
import { GoogleAccountRepository } from '../../../persistence/repositories/google-account.repository.js';
import { DriveUnavailableError, EntityNotFoundError } from '../../../domain/errors.js';

export class GoogleOAuthService {
  private static readonly GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
  private static readonly GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
  private static readonly GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';

  private static readonly DEFAULT_SCOPES = [
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
  ];

  constructor(
    private config: GoogleOAuthConfig,
    private encryptor: ITokenEncryptor,
    private accountRepo: GoogleAccountRepository
  ) {}

  /**
   * Generates Google OAuth authorization URL.
   */
  generateAuthUrl(state?: string): string {
    const scopes = this.config.scopes || GoogleOAuthService.DEFAULT_SCOPES;
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      response_type: 'code',
      scope: scopes.join(' '),
      access_type: 'offline',
      include_granted_scopes: 'true',
    });

    if (state) {
      params.append('state', state);
    }

    return `${GoogleOAuthService.GOOGLE_AUTH_URL}?${params.toString()}`;
  }

  /**
   * Exchanges an authorization code for tokens and Google user profile.
   */
  async exchangeCode(code: string): Promise<{ tokens: OAuthTokens; profile: GoogleUserProfile }> {
    const params = new URLSearchParams({
      code,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      redirect_uri: this.config.redirectUri,
      grant_type: 'authorization_code',
    });

    const response = await fetch(GoogleOAuthService.GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!response.ok) {
      const errorData = await response.text();
      throw new Error(`Failed to exchange authorization code: ${response.status} - ${errorData}`);
    }

    const data = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      token_type?: string;
      scope?: string;
    };

    const tokens: OAuthTokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000,
      tokenType: data.token_type,
      scope: data.scope,
    };

    const profile = await this.fetchUserProfile(tokens.accessToken);
    return { tokens, profile };
  }

  /**
   * Refreshes an access token using a refresh token.
   */
  async refreshAccessToken(refreshToken: string): Promise<OAuthTokens> {
    const params = new URLSearchParams({
      refresh_token: refreshToken,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      grant_type: 'refresh_token',
    });

    const response = await fetch(GoogleOAuthService.GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!response.ok) {
      const errorData = await response.text();
      throw new Error(`Failed to refresh access token: ${response.status} - ${errorData}`);
    }

    const data = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      token_type?: string;
      scope?: string;
    };

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshToken, // Retain existing if not rotated
      expiresAt: Date.now() + data.expires_in * 1000,
      tokenType: data.token_type,
      scope: data.scope,
    };
  }

  /**
   * Fetches the user profile from Google.
   */
  async fetchUserProfile(accessToken: string): Promise<GoogleUserProfile> {
    const response = await fetch(GoogleOAuthService.GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch user profile: ${response.status}`);
    }

    const data = (await response.json()) as {
      id: string;
      email: string;
      name: string;
      picture?: string;
    };

    return {
      id: data.id,
      email: data.email,
      name: data.name || data.email,
      picture: data.picture,
    };
  }

  /**
   * Retrieves a valid access token for a stored account.
   * Auto-refreshes and persists if the current token is near expiry.
   */
  async getValidAccessToken(accountId: number): Promise<string> {
    const account = this.accountRepo.findById(accountId);
    if (!account) {
      throw new EntityNotFoundError('Google Account', accountId);
    }

    if (account.status === 'UNAVAILABLE' || account.status === 'DISCONNECTED') {
      throw new DriveUnavailableError(
        `Drive ${account.displayName} (${account.email}) is currently ${account.status}`
      );
    }

    let tokens: OAuthTokens;
    try {
      const decrypted = this.encryptor.decrypt(account.encryptedCredentials);
      tokens = JSON.parse(decrypted) as OAuthTokens;
    } catch (err) {
      throw new Error(`Failed to decrypt credentials for account ${accountId}`);
    }

    const REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes buffer
    const isExpiring = Date.now() + REFRESH_BUFFER_MS >= tokens.expiresAt;

    if (!isExpiring) {
      return tokens.accessToken;
    }

    if (!tokens.refreshToken) {
      throw new DriveUnavailableError(
        `No refresh token available for account ${account.email}. Reconnection required.`
      );
    }

    try {
      const refreshedTokens = await this.refreshAccessToken(tokens.refreshToken);
      const encrypted = this.encryptor.encrypt(JSON.stringify(refreshedTokens));
      this.accountRepo.updateCredentials(accountId, encrypted);
      return refreshedTokens.accessToken;
    } catch (error) {
      this.accountRepo.updateStatus(accountId, 'UNAVAILABLE');
      throw new DriveUnavailableError(
        `Failed to refresh authorization for Drive ${account.email}: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }
}
