import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { InMemoryStorageProvider } from '../../src/providers/memory/in-memory-storage.provider.js';

describe('InMemoryStorageProvider Suite', () => {
  it('uploads, downloads, and verifies stream integrity', async () => {
    const provider = new InMemoryStorageProvider(1000000);
    const content = Buffer.from('Hello Smart Drive Storage Engine!');

    let progressCalls = 0;
    const uploadMeta = await provider.uploadStream(Readable.from(content), {
      filename: 'hello.txt',
      mimeType: 'text/plain',
      size: content.length,
      onProgress: () => {
        progressCalls++;
      },
    });

    expect(uploadMeta.providerFileId).toBeDefined();
    expect(uploadMeta.size).toBe(content.length);
    expect(uploadMeta.checksum).toBeDefined();
    expect(uploadMeta.checksumType).toBe('MD5');
    expect(progressCalls).toBeGreaterThan(0);

    // Download stream
    const downloadStream = await provider.downloadStream(uploadMeta.providerFileId);
    const chunks: Buffer[] = [];
    for await (const chunk of downloadStream) {
      chunks.push(chunk);
    }
    const downloadedData = Buffer.concat(chunks);
    expect(downloadedData.toString()).toBe('Hello Smart Drive Storage Engine!');

    // Quota verification
    const quota = await provider.getQuota();
    expect(quota.usedBytes).toBe(content.length);
    expect(quota.freeBytes).toBe(1000000 - content.length);

    // Server-side copy
    const copiedMeta = await provider.serverSideCopy(uploadMeta.providerFileId, 'hello_copy.txt');
    expect(copiedMeta.providerFileId).not.toBe(uploadMeta.providerFileId);
    expect(copiedMeta.size).toBe(content.length);
    expect(copiedMeta.checksum).toBe(uploadMeta.checksum);

    // Delete
    const deleted = await provider.deleteFile(uploadMeta.providerFileId);
    expect(deleted).toBe(true);
  });

  it('handles simulated errors properly', async () => {
    const provider = new InMemoryStorageProvider();
    provider.failNextUpload = true;

    await expect(
      provider.uploadStream(Readable.from(Buffer.from('fail')), {
        filename: 'fail.txt',
        mimeType: 'text/plain',
      })
    ).rejects.toThrow(/Simulated physical upload failure/);
  });
});
