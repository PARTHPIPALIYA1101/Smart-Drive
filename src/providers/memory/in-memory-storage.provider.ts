import { Readable, PassThrough } from 'node:stream';
import * as crypto from 'node:crypto';
import {
  IStorageProvider,
  ProviderFileMetadata,
  ProviderQuota,
  ProviderUploadOptions,
  StorageProviderCapabilities,
} from '../storage-provider.interface.js';

interface StoredFile {
  data: Buffer;
  filename: string;
  mimeType: string;
  size: number;
  checksum: string;
}

interface InMemoryResumableSession {
  sessionUri: string;
  filename: string;
  mimeType: string;
  totalBytes: number;
  uploadedBytes: number;
  chunks: Buffer[];
  hash: crypto.Hash;
  providerFileId: string;
  aborted?: boolean;
}

export class InMemoryStorageProvider implements IStorageProvider {
  private files = new Map<string, StoredFile>();
  private sessions = new Map<string, InMemoryResumableSession>();
  private idCounter = 1;
  public totalCapacityBytes: number;
  public failNextUpload = false;
  public failNextDownload = false;
  public failNextDelete = false;

  constructor(totalCapacityBytes = 15 * 1024 * 1024 * 1024) {
    this.totalCapacityBytes = totalCapacityBytes;
  }

  getCapabilities(): StorageProviderCapabilities {
    return {
      supportsServerSideCopy: true,
      supportsCrossAccountCopy: false,
      supportsResumableUpload: true,
      supportsStreamingDownload: true,
      checksumType: 'MD5',
    };
  }

  async createResumableSession(options: ProviderUploadOptions): Promise<string> {
    if (this.failNextUpload) {
      this.failNextUpload = false;
      throw new Error('Simulated physical upload failure');
    }

    const sessionUri = `mem-session-${this.idCounter++}-${Date.now()}`;
    const providerFileId = `mem-file-${this.idCounter++}`;
    this.sessions.set(sessionUri, {
      sessionUri,
      filename: options.filename,
      mimeType: options.mimeType,
      totalBytes: options.size ?? 0,
      uploadedBytes: 0,
      chunks: [],
      hash: crypto.createHash('md5'),
      providerFileId,
    });

    return sessionUri;
  }

  async queryResumableOffset(sessionUri: string, _totalBytes: number): Promise<number> {
    const session = this.sessions.get(sessionUri);
    if (!session || session.aborted) {
      throw new Error(`Resumable session ${sessionUri} not found or expired`);
    }
    return session.uploadedBytes;
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
      isPartial?: boolean;
    }
  ): Promise<ProviderFileMetadata> {
    const session = this.sessions.get(sessionUri);
    if (!session || session.aborted) {
      throw new Error(`Resumable session ${sessionUri} not found or aborted`);
    }

    let currentOffset = options.startByte;

    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      session.chunks.push(buf);
      session.hash.update(buf);
      currentOffset += buf.length;
      session.uploadedBytes = currentOffset;

      if (options.onProgress) {
        options.onProgress(currentOffset);
      }

      if (options.abortSignal?.aborted) {
        throw new Error('Upload aborted by client signal');
      }
    }

    if (options.isPartial !== true || session.totalBytes <= 0 || session.uploadedBytes >= session.totalBytes) {
      const fullBuffer = Buffer.concat(session.chunks);
      const checksum = session.hash.digest('hex');

      this.files.set(session.providerFileId, {
        data: fullBuffer,
        filename: session.filename,
        mimeType: session.mimeType,
        size: fullBuffer.length,
        checksum,
      });

      this.sessions.delete(sessionUri);

      return {
        providerFileId: session.providerFileId,
        filename: session.filename,
        size: fullBuffer.length,
        mimeType: session.mimeType,
        checksum,
        checksumType: 'MD5',
      };
    }

    return {
      providerFileId: session.providerFileId,
      filename: session.filename,
      size: session.uploadedBytes,
      mimeType: session.mimeType,
      checksum: null,
      checksumType: 'MD5',
    };
  }

  async abortSession(sessionUri: string): Promise<void> {
    const session = this.sessions.get(sessionUri);
    if (session) {
      session.aborted = true;
      session.chunks = [];
      this.sessions.delete(sessionUri);
    }
  }

  async uploadStream(stream: Readable, options: ProviderUploadOptions): Promise<ProviderFileMetadata> {
    const sessionUri = await this.createResumableSession(options);
    const meta = await this.uploadStreamToSession(sessionUri, stream, {
      startByte: 0,
      totalBytes: options.size ?? 0,
      mimeType: options.mimeType,
      filename: options.filename,
      abortSignal: options.abortSignal,
      onProgress: (b) => options.onProgress?.(b, options.size),
    });

    const session = this.sessions.get(sessionUri);
    if (session && session.uploadedBytes > 0) {
      const fullBuffer = Buffer.concat(session.chunks);
      const checksum = session.hash.digest('hex');
      this.files.set(session.providerFileId, {
        data: fullBuffer,
        filename: session.filename,
        mimeType: session.mimeType,
        size: fullBuffer.length,
        checksum,
      });
      this.sessions.delete(sessionUri);
      return {
        providerFileId: session.providerFileId,
        filename: session.filename,
        size: fullBuffer.length,
        mimeType: session.mimeType,
        checksum,
        checksumType: 'MD5',
      };
    }

    return meta;
  }

  async downloadStream(providerFileId: string, _options?: { exportMimeType?: string }): Promise<Readable> {
    if (this.failNextDownload) {
      this.failNextDownload = false;
      throw new Error('Simulated physical download failure');
    }

    const file = this.files.get(providerFileId);
    if (!file) {
      throw new Error(`File ${providerFileId} not found on provider`);
    }

    const stream = new PassThrough();
    process.nextTick(() => {
      stream.write(file.data);
      stream.end();
    });

    return stream;
  }

  async getFileMetadata(providerFileId: string): Promise<ProviderFileMetadata> {
    const file = this.files.get(providerFileId);
    if (!file) {
      throw new Error(`File ${providerFileId} not found on provider`);
    }

    return {
      providerFileId,
      filename: file.filename,
      size: file.size,
      mimeType: file.mimeType,
      checksum: file.checksum,
      checksumType: 'MD5',
    };
  }

  async deleteFile(providerFileId: string): Promise<boolean> {
    if (this.failNextDelete) {
      this.failNextDelete = false;
      throw new Error('Simulated physical deletion failure');
    }

    return this.files.delete(providerFileId);
  }

  async getQuota(): Promise<ProviderQuota> {
    let usedBytes = 0;
    for (const file of this.files.values()) {
      usedBytes += file.size;
    }

    return {
      totalBytes: this.totalCapacityBytes,
      usedBytes,
      freeBytes: Math.max(0, this.totalCapacityBytes - usedBytes),
    };
  }

  async serverSideCopy(sourceProviderFileId: string, newFilename: string): Promise<ProviderFileMetadata> {
    const source = this.files.get(sourceProviderFileId);
    if (!source) {
      throw new Error(`Source file ${sourceProviderFileId} not found`);
    }

    const newProviderFileId = `mem-file-${this.idCounter++}`;
    this.files.set(newProviderFileId, {
      data: Buffer.from(source.data),
      filename: newFilename,
      mimeType: source.mimeType,
      size: source.size,
      checksum: source.checksum,
    });

    return {
      providerFileId: newProviderFileId,
      filename: newFilename,
      size: source.size,
      mimeType: source.mimeType,
      checksum: source.checksum,
      checksumType: 'MD5',
    };
  }
}
