export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number; // Unix timestamp in milliseconds
  tokenType?: string;
  scope?: string;
}

export interface GoogleUserProfile {
  id: string;
  email: string;
  name: string;
  picture?: string;
}

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes?: string[];
}
