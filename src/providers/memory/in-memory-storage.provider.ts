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

export class InMemoryStorageProvider implements IStorageProvider {
  private files = new Map<string, StoredFile>();
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

  async uploadStream(stream: Readable, options: ProviderUploadOptions): Promise<ProviderFileMetadata> {
    if (this.failNextUpload) {
      this.failNextUpload = false;
      throw new Error('Simulated physical upload failure');
    }

    const chunks: Buffer[] = [];
    let uploadedBytes = 0;

    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(buf);
      uploadedBytes += buf.length;
      if (options.onProgress) {
        options.onProgress(uploadedBytes, options.size);
      }
    }

    const fullBuffer = Buffer.concat(chunks);
    const checksum = crypto.createHash('md5').update(fullBuffer).digest('hex');
    const providerFileId = `mem-file-${this.idCounter++}`;

    this.files.set(providerFileId, {
      data: fullBuffer,
      filename: options.filename,
      mimeType: options.mimeType,
      size: fullBuffer.length,
      checksum,
    });

    return {
      providerFileId,
      filename: options.filename,
      size: fullBuffer.length,
      mimeType: options.mimeType,
      checksum,
      checksumType: 'MD5',
    };
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
