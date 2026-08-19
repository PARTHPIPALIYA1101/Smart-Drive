import { Readable } from 'node:stream';
import {
  IStorageProvider,
  ProviderFileMetadata,
  ProviderQuota,
  ProviderUploadOptions,
  StorageProviderCapabilities,
} from '../storage-provider.interface.js';
import { GoogleOAuthService } from './auth/google-oauth.service.js';
import { VerificationFailedError } from '../../domain/errors.js';

export interface WorkspaceExportFormatConfig {
  defaultExportMimeType: string;
  supportedMimeTypes: string[];
  description: string;
}

export const GOOGLE_WORKSPACE_EXPORT_FORMATS: Record<string, WorkspaceExportFormatConfig> = {
  'application/vnd.google-apps.document': {
    defaultExportMimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    supportedMimeTypes: [
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/pdf',
      'text/plain',
      'text/html',
      'application/rtf',
      'application/vnd.oasis.opendocument.text',
      'application/epub+zip',
    ],
    description: 'Google Docs',
  },
  'application/vnd.google-apps.spreadsheet': {
    defaultExportMimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    supportedMimeTypes: [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/csv',
      'application/pdf',
      'application/vnd.oasis.opendocument.spreadsheet',
      'text/tab-separated-values',
      'application/zip',
    ],
    description: 'Google Sheets',
  },
  'application/vnd.google-apps.presentation': {
    defaultExportMimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    supportedMimeTypes: [
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/pdf',
      'application/vnd.oasis.opendocument.presentation',
      'text/plain',
    ],
    description: 'Google Slides',
  },
  'application/vnd.google-apps.drawing': {
    defaultExportMimeType: 'image/png',
    supportedMimeTypes: [
      'image/png',
      'image/jpeg',
      'application/pdf',
      'image/svg+xml',
    ],
    description: 'Google Drawings',
  },
  'application/vnd.google-apps.script': {
    defaultExportMimeType: 'application/vnd.google-apps.script+json',
    supportedMimeTypes: ['application/vnd.google-apps.script+json'],
    description: 'Google Apps Script',
  },
};

export class GoogleDriveProvider implements IStorageProvider {
  private static readonly API_BASE = 'https://www.googleapis.com/drive/v3';
  private static readonly UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';

  constructor(
    private accountId: number,
    private oauthService: GoogleOAuthService
  ) {}

  getCapabilities(): StorageProviderCapabilities {
    return {
      supportsServerSideCopy: true,
      supportsCrossAccountCopy: false,
      supportsResumableUpload: true,
      supportsStreamingDownload: true,
      checksumType: 'MD5',
    };
  }

  private async fetchWithRetry(
    url: string,
    options: RequestInit = {},
    maxRetries = 3
  ): Promise<Response> {
    let delay = 500;
    const token = await this.oauthService.getValidAccessToken(this.accountId);

    const headers = new Headers(options.headers || {});
    headers.set('Authorization', `Bearer ${token}`);

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(url, { ...options, headers });

        if (response.status === 429 || response.status >= 500) {
          if (attempt === maxRetries) {
            return response;
          }
          await new Promise((r) => setTimeout(r, delay + Math.random() * 200));
          delay *= 2;
          continue;
        }

        return response;
      } catch (err) {
        if (attempt === maxRetries) throw err;
        await new Promise((r) => setTimeout(r, delay + Math.random() * 200));
        delay *= 2;
      }
    }

    throw new Error(`Request to ${url} failed after ${maxRetries} attempts`);
  }

  async createResumableSession(options: ProviderUploadOptions): Promise<string> {
    const token = await this.oauthService.getValidAccessToken(this.accountId);

    const initResponse = await fetch(
      `${GoogleDriveProvider.UPLOAD_BASE}/files?uploadType=resumable`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': options.mimeType,
          ...(options.size !== undefined ? { 'X-Upload-Content-Length': options.size.toString() } : {}),
        },
        body: JSON.stringify({
          name: options.filename,
          mimeType: options.mimeType,
        }),
      }
    );

    if (!initResponse.ok) {
      const err = await initResponse.text();
      throw new Error(`Failed to initialize Google Drive upload: ${initResponse.status} - ${err}`);
    }

    const sessionUri = initResponse.headers.get('location');
    if (!sessionUri) {
      throw new Error('Google Drive upload session URI was not returned in Location header');
    }

    return sessionUri;
  }

  async queryResumableOffset(sessionUri: string, totalBytes: number): Promise<number> {
    try {
      const response = await fetch(sessionUri, {
        method: 'PUT',
        headers: {
          'Content-Range': `bytes */${totalBytes}`,
        },
      });

      if (response.status === 308) {
        const range = response.headers.get('range');
        if (range) {
          const match = range.match(/bytes=0-(\d+)/);
          if (match) {
            return parseInt(match[1], 10) + 1;
          }
        }
        return 0;
      } else if (response.status === 200 || response.status === 201) {
        return totalBytes;
      } else if (response.status === 404 || response.status === 410) {
        throw new Error(`Google Drive resumable session expired or invalid: ${response.status}`);
      } else {
        throw new Error(`Failed to query Google Drive resumable offset: ${response.status}`);
      }
    } catch (err: any) {
      if (err.message.includes('expired or invalid')) throw err;
      throw new Error(`Failed to query resumable session: ${err.message}`);
    }
  }

  async uploadStreamToSession(
    sessionUri: string,
    stream: Readable,
    options: {
      startByte: number;
      totalBytes: number;
      mimeType: string;
      filename?: string;
      abortSignal?: AbortSignal;
      onProgress?: (bytesUploaded: number) => void;
    }
  ): Promise<ProviderFileMetadata> {
    const contentLength = Math.max(0, options.totalBytes - options.startByte);
    const contentRange = `bytes ${options.startByte}-${options.totalBytes - 1}/${options.totalBytes}`;
    const bodyStream = (Readable as any).toWeb ? (Readable as any).toWeb(stream) : stream;

    const uploadResponse = await fetch(sessionUri, {
      method: 'PUT',
      headers: {
        'Content-Type': options.mimeType,
        'Content-Length': contentLength.toString(),
        'Content-Range': contentRange,
      },
      body: bodyStream as any,
      duplex: 'half',
      signal: options.abortSignal,
    });

    if (!uploadResponse.ok) {
      const err = await uploadResponse.text();
      throw new Error(`Failed to stream upload to Google Drive: ${uploadResponse.status} - ${err}`);
    }

    const result = (await uploadResponse.json()) as {
      id: string;
      name: string;
      size?: string;
      mimeType: string;
      md5Checksum?: string;
    };

    const actualSize = result.size ? parseInt(result.size, 10) : options.totalBytes;

    return {
      providerFileId: result.id,
      filename: result.name || options.filename || 'Untitled',
      size: actualSize,
      mimeType: result.mimeType || options.mimeType,
      checksum: result.md5Checksum || null,
      checksumType: 'MD5',
    };
  }

  async abortSession(sessionUri: string): Promise<void> {
    try {
      await fetch(sessionUri, {
        method: 'DELETE',
        headers: {
          'Content-Length': '0',
        },
      });
    } catch {
      // Best-effort session abort
    }
  }

  async uploadStream(stream: Readable, options: ProviderUploadOptions): Promise<ProviderFileMetadata> {
    const sessionUri = await this.createResumableSession(options);
    return this.uploadStreamToSession(sessionUri, stream, {
      startByte: 0,
      totalBytes: options.size ?? 0,
      mimeType: options.mimeType,
      filename: options.filename,
      abortSignal: options.abortSignal,
      onProgress: options.onProgress,
    });
  }

  async downloadStream(providerFileId: string, options?: { exportMimeType?: string }): Promise<Readable> {
    const metadata = await this.getFileMetadata(providerFileId);
    const token = await this.oauthService.getValidAccessToken(this.accountId);

    // If this is a Google Workspace file (Docs, Sheets, Slides, Drawings, etc.), use the export endpoint
    if (metadata.mimeType.startsWith('application/vnd.google-apps.')) {
      const exportConfig = GOOGLE_WORKSPACE_EXPORT_FORMATS[metadata.mimeType];
      if (!exportConfig) {
        throw new Error(
          `Unsupported Google Workspace file type: ${metadata.mimeType}. This file format cannot be exported directly.`
        );
      }

      let exportMimeType = exportConfig.defaultExportMimeType;
      if (options?.exportMimeType) {
        if (!exportConfig.supportedMimeTypes.includes(options.exportMimeType)) {
          throw new Error(
            `Unsupported export format '${options.exportMimeType}' for ${exportConfig.description} (${metadata.mimeType}). Supported formats: ${exportConfig.supportedMimeTypes.join(', ')}`
          );
        }
        exportMimeType = options.exportMimeType;
      }

      const exportUrl = `${GoogleDriveProvider.API_BASE}/files/${encodeURIComponent(
        providerFileId
      )}/export?mimeType=${encodeURIComponent(exportMimeType)}`;

      const response = await fetch(exportUrl, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!response.ok) {
        const err = await response.text();
        throw new Error(`Failed to export Google Workspace file ${providerFileId}: ${response.status} - ${err}`);
      }

      if (!response.body) {
        throw new Error(`No response stream received for exported file ${providerFileId}`);
      }

      return (Readable as any).fromWeb(response.body);
    }

    // Binary file download
    if (options?.exportMimeType) {
      throw new Error(
        `Export format '${options.exportMimeType}' is not supported for binary file '${metadata.filename}' (${metadata.mimeType}).`
      );
    }

    const url = `${GoogleDriveProvider.API_BASE}/files/${encodeURIComponent(providerFileId)}?alt=media`;

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Failed to download file ${providerFileId}: ${response.status} - ${err}`);
    }

    if (!response.body) {
      throw new Error(`No response stream received for file ${providerFileId}`);
    }

    // Convert Web ReadableStream to Node.js Readable
    return (Readable as any).fromWeb(response.body);
  }

  async getFileMetadata(providerFileId: string): Promise<ProviderFileMetadata> {
    const url = `${GoogleDriveProvider.API_BASE}/files/${encodeURIComponent(
      providerFileId
    )}?fields=id,name,size,mimeType,md5Checksum,trashed`;

    const response = await this.fetchWithRetry(url);
    if (!response.ok) {
      throw new Error(`Failed to get file metadata for ${providerFileId}: ${response.status}`);
    }

    const data = (await response.json()) as {
      id: string;
      name: string;
      size?: string;
      mimeType: string;
      md5Checksum?: string;
      trashed?: boolean;
    };

    if (data.trashed) {
      throw new VerificationFailedError(`Provider file ${providerFileId} is in Google Drive trash`);
    }

    return {
      providerFileId: data.id,
      filename: data.name,
      size: data.size ? parseInt(data.size, 10) : 0,
      mimeType: data.mimeType,
      checksum: data.md5Checksum || null,
      checksumType: 'MD5',
    };
  }

  async deleteFile(providerFileId: string): Promise<boolean> {
    const url = `${GoogleDriveProvider.API_BASE}/files/${encodeURIComponent(providerFileId)}`;
    const response = await this.fetchWithRetry(url, { method: 'DELETE' });

    if (response.status === 404) {
      return true; // Already deleted
    }

    return response.ok;
  }

  async getQuota(): Promise<ProviderQuota> {
    const url = `${GoogleDriveProvider.API_BASE}/about?fields=storageQuota`;
    const response = await this.fetchWithRetry(url);

    if (!response.ok) {
      throw new Error(`Failed to fetch storage quota: ${response.status}`);
    }

    const data = (await response.json()) as {
      storageQuota?: {
        limit?: string;
        usage?: string;
      };
    };

    const totalBytes = data.storageQuota?.limit ? parseInt(data.storageQuota.limit, 10) : 0;
    const usedBytes = data.storageQuota?.usage ? parseInt(data.storageQuota.usage, 10) : 0;
    const freeBytes = Math.max(0, totalBytes - usedBytes);

    return {
      totalBytes,
      usedBytes,
      freeBytes,
    };
  }

  async serverSideCopy(sourceProviderFileId: string, newFilename: string): Promise<ProviderFileMetadata> {
    const url = `${GoogleDriveProvider.API_BASE}/files/${encodeURIComponent(
      sourceProviderFileId
    )}/copy?fields=id,name,size,mimeType,md5Checksum`;

    const response = await this.fetchWithRetry(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ name: newFilename }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Server-side copy failed for ${sourceProviderFileId}: ${response.status} - ${err}`);
    }

    const data = (await response.json()) as {
      id: string;
      name: string;
      size?: string;
      mimeType: string;
      md5Checksum?: string;
    };

    return {
      providerFileId: data.id,
      filename: data.name,
      size: data.size ? parseInt(data.size, 10) : 0,
      mimeType: data.mimeType,
      checksum: data.md5Checksum || null,
      checksumType: 'MD5',
    };
  }

  async listFiles(query = "trashed = false and mimeType != 'application/vnd.google-apps.folder'"): Promise<ProviderFileMetadata[]> {
    const url = `${GoogleDriveProvider.API_BASE}/files?q=${encodeURIComponent(
      query
    )}&fields=files(id,name,size,mimeType,md5Checksum,trashed)&pageSize=100`;

    const response = await this.fetchWithRetry(url);
    if (!response.ok) {
      throw new Error(`Failed to list files from Google Drive: ${response.status}`);
    }

    const data = (await response.json()) as {
      files?: Array<{
        id: string;
        name: string;
        size?: string;
        mimeType: string;
        md5Checksum?: string;
      }>;
    };

    if (!data.files) return [];

    return data.files.map((f) => ({
      providerFileId: f.id,
      filename: f.name,
      size: f.size ? parseInt(f.size, 10) : 0,
      mimeType: f.mimeType,
      checksum: f.md5Checksum || null,
      checksumType: 'MD5',
    }));
  }
}

