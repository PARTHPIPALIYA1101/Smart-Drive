import { Readable } from 'node:stream';
import { ChecksumType } from '../domain/types.js';

export interface StorageProviderCapabilities {
  supportsServerSideCopy: boolean;
  supportsCrossAccountCopy: boolean;
  supportsResumableUpload: boolean;
  supportsStreamingDownload: boolean;
  checksumType: ChecksumType;
}

export interface ProviderFileMetadata {
  providerFileId: string;
  filename: string;
  size: number;
  mimeType: string;
  checksum: string | null;
  checksumType: ChecksumType;
}

export interface ProviderUploadOptions {
  filename: string;
  mimeType: string;
  size?: number;
  onProgress?: (bytesUploaded: number, totalBytes?: number) => void;
  abortSignal?: AbortSignal;
}

export interface ProviderQuota {
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
}

export interface DownloadStreamOptions {
  exportMimeType?: string;
  abortSignal?: AbortSignal;
}

export interface IStorageProvider {
  /**
   * Uploads a data stream to the physical provider.
   */
  uploadStream(stream: Readable, options: ProviderUploadOptions): Promise<ProviderFileMetadata>;

  /**
   * Creates a dedicated resumable upload session on the physical provider.
   */
  createResumableSession?(options: ProviderUploadOptions): Promise<string>;

  /**
   * Queries the provider's resumable session for the exact byte offset already uploaded.
   */
  queryResumableOffset?(sessionUri: string, totalBytes: number): Promise<number>;

  /**
   * Uploads a stream chunk / remaining slice to an existing resumable session starting at offset.
   */
  uploadStreamToSession?(
    sessionUri: string,
    stream: Readable,
    options: {
      startByte: number;
      totalBytes: number;
      mimeType: string;
      filename?: string;
      abortSignal?: AbortSignal;
      onProgress?: (bytesUploaded: number) => void;
      isPartial?: boolean;
    }
  ): Promise<ProviderFileMetadata>;

  /**
   * Aborts / cancels an active resumable upload session on the physical provider.
   */
  abortSession?(sessionUri: string): Promise<void>;

  /**
   * Streams a file down from the physical provider.
   */
  downloadStream(providerFileId: string, options?: DownloadStreamOptions): Promise<Readable>;

  /**
   * Retrieves physical metadata for a file from the provider.
   */
  getFileMetadata(providerFileId: string): Promise<ProviderFileMetadata>;

  /**
   * Deletes a file physically from the provider.
   */
  deleteFile(providerFileId: string): Promise<boolean>;

  /**
   * Retrieves overall storage quota from the provider.
   */
  getQuota(): Promise<ProviderQuota>;

  /**
   * Lists files directly from the physical provider.
   */
  listFiles?(query?: string): Promise<ProviderFileMetadata[]>;

  /**
   * Optional server-side copy within the same provider account.
   */
  serverSideCopy?(sourceProviderFileId: string, newFilename: string): Promise<ProviderFileMetadata>;

  /**
   * Returns provider capabilities.
   */
  getCapabilities(): StorageProviderCapabilities;
}
