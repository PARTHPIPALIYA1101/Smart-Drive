import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Readable } from 'node:stream';
import { GoogleDriveProvider } from '../../src/providers/google-drive/google-drive.provider.js';
import { GoogleOAuthService } from '../../src/providers/google-drive/auth/google-oauth.service.js';
import { StorageProviderFactory } from '../../src/providers/provider-factory.js';
import { InMemoryStorageProvider } from '../../src/providers/memory/in-memory-storage.provider.js';

describe('GoogleDriveProvider Suite', () => {
  let mockOAuth: GoogleOAuthService;
  let provider: GoogleDriveProvider;

  beforeEach(() => {
    mockOAuth = {
      getValidAccessToken: vi.fn().mockResolvedValue('valid-google-access-token'),
    } as unknown as GoogleOAuthService;

    provider = new GoogleDriveProvider(1, mockOAuth);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('performs resumable upload protocol to Google Drive endpoints', async () => {
    const sessionUri = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=session-999';

    // Mock initial POST for session URI and PUT for payload
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ location: sessionUri }),
      } as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'gdrive-file-abc',
          name: 'report.pdf',
          size: '1048576',
          mimeType: 'application/pdf',
          md5Checksum: 'd41d8cd98f00b204e9800998ecf8427e',
        }),
      } as any);

    const stream = Readable.from(Buffer.from('PDF byte contents'));
    const result = await provider.uploadStream(stream, {
      filename: 'report.pdf',
      mimeType: 'application/pdf',
      size: 1048576,
    });

    expect(result.providerFileId).toBe('gdrive-file-abc');
    expect(result.filename).toBe('report.pdf');
    expect(result.size).toBe(1048576);
    expect(result.checksum).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(result.checksumType).toBe('MD5');
  });

  it('retrieves storage quota from Google Drive about endpoint', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        storageQuota: {
          limit: '16106127360', // 15 GB
          usage: '5368709120',  // 5 GB
        },
      }),
    } as any);

    const quota = await provider.getQuota();
    expect(quota.totalBytes).toBe(16106127360);
    expect(quota.usedBytes).toBe(5368709120);
    expect(quota.freeBytes).toBe(10737418240); // 10 GB
  });

  it('retries on transient rate limits (HTTP 429) with exponential backoff', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        status: 429,
        ok: false,
      } as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'gdrive-file-123',
          name: 'image.png',
          size: '2048',
          mimeType: 'image/png',
          md5Checksum: 'hash123',
          trashed: false,
        }),
      } as any);

    const meta = await provider.getFileMetadata('gdrive-file-123');
    expect(meta.providerFileId).toBe('gdrive-file-123');
    expect(meta.filename).toBe('image.png');
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('resolves mock providers and google providers via StorageProviderFactory', () => {
    const factory = new StorageProviderFactory(mockOAuth);
    const gProvider = factory.getProvider(10);
    expect(gProvider).toBeInstanceOf(GoogleDriveProvider);

    const memProvider = new InMemoryStorageProvider();
    factory.registerMockProvider(99, memProvider);
    expect(factory.getProvider(99)).toBe(memProvider);
  });

  describe('downloadStream & Google Workspace exports', () => {
    it('1. downloads normal binary files using files.get with alt=media', async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            id: 'binary-file-123',
            name: 'archive.zip',
            size: '5000',
            mimeType: 'application/zip',
            md5Checksum: 'checksum123',
            trashed: false,
          }),
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          body: (Readable as any).toWeb(Readable.from(Buffer.from('binary-content'))),
        } as any);

      const stream = await provider.downloadStream('binary-file-123');
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      expect(Buffer.concat(chunks).toString()).toBe('binary-content');

      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect((global.fetch as any).mock.calls[1][0]).toContain('/files/binary-file-123?alt=media');
    });

    it('2. exports Google Docs files to DOCX (default) or requested format (PDF)', async () => {
      // Default DOCX export
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            id: 'doc-file-1',
            name: 'Project Plan',
            size: '0',
            mimeType: 'application/vnd.google-apps.document',
            trashed: false,
          }),
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          body: (Readable as any).toWeb(Readable.from(Buffer.from('docx-bytes'))),
        } as any);

      const stream = await provider.downloadStream('doc-file-1');
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      expect(Buffer.concat(chunks).toString()).toBe('docx-bytes');
      expect((global.fetch as any).mock.calls[1][0]).toContain(
        '/files/doc-file-1/export?mimeType=application%2Fvnd.openxmlformats-officedocument.wordprocessingml.document'
      );

      // Custom format: PDF
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            id: 'doc-file-1',
            name: 'Project Plan',
            size: '0',
            mimeType: 'application/vnd.google-apps.document',
            trashed: false,
          }),
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          body: (Readable as any).toWeb(Readable.from(Buffer.from('pdf-bytes'))),
        } as any);

      const pdfStream = await provider.downloadStream('doc-file-1', {
        exportMimeType: 'application/pdf',
      });
      const pdfChunks: Buffer[] = [];
      for await (const chunk of pdfStream) {
        pdfChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      expect(Buffer.concat(pdfChunks).toString()).toBe('pdf-bytes');
      expect((global.fetch as any).mock.calls[1][0]).toContain(
        '/files/doc-file-1/export?mimeType=application%2Fpdf'
      );
    });

    it('3. exports Google Sheets files to XLSX (default) or CSV', async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            id: 'sheet-file-1',
            name: 'Budget 2026',
            size: '0',
            mimeType: 'application/vnd.google-apps.spreadsheet',
            trashed: false,
          }),
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          body: (Readable as any).toWeb(Readable.from(Buffer.from('xlsx-bytes'))),
        } as any);

      const stream = await provider.downloadStream('sheet-file-1');
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      expect(Buffer.concat(chunks).toString()).toBe('xlsx-bytes');
      expect((global.fetch as any).mock.calls[1][0]).toContain(
        '/files/sheet-file-1/export?mimeType=application%2Fvnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );

      // CSV export
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            id: 'sheet-file-1',
            name: 'Budget 2026',
            size: '0',
            mimeType: 'application/vnd.google-apps.spreadsheet',
            trashed: false,
          }),
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          body: (Readable as any).toWeb(Readable.from(Buffer.from('col1,col2\nval1,val2'))),
        } as any);

      const csvStream = await provider.downloadStream('sheet-file-1', {
        exportMimeType: 'text/csv',
      });
      const csvChunks: Buffer[] = [];
      for await (const chunk of csvStream) {
        csvChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      expect(Buffer.concat(csvChunks).toString()).toBe('col1,col2\nval1,val2');
      expect((global.fetch as any).mock.calls[1][0]).toContain(
        '/files/sheet-file-1/export?mimeType=text%2Fcsv'
      );
    });

    it('4. exports Google Slides files to PPTX (default) or PDF', async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            id: 'slides-file-1',
            name: 'Keynote Deck',
            size: '0',
            mimeType: 'application/vnd.google-apps.presentation',
            trashed: false,
          }),
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          body: (Readable as any).toWeb(Readable.from(Buffer.from('pptx-bytes'))),
        } as any);

      const stream = await provider.downloadStream('slides-file-1');
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      expect(Buffer.concat(chunks).toString()).toBe('pptx-bytes');
      expect((global.fetch as any).mock.calls[1][0]).toContain(
        '/files/slides-file-1/export?mimeType=application%2Fvnd.openxmlformats-officedocument.presentationml.presentation'
      );
    });

    it('5. returns clear error for unsupported Workspace file type or unsupported format', async () => {
      // 5a. Unsupported Workspace file type (e.g. Google Form)
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            id: 'form-file-1',
            name: 'Feedback Form',
            size: '0',
            mimeType: 'application/vnd.google-apps.form',
            trashed: false,
          }),
        } as any);

      await expect(provider.downloadStream('form-file-1')).rejects.toThrow(
        /Unsupported Google Workspace file type: application\/vnd\.google-apps\.form/
      );

      // 5b. Unsupported export format for Google Docs (e.g. image/png)
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            id: 'doc-file-1',
            name: 'Project Plan',
            size: '0',
            mimeType: 'application/vnd.google-apps.document',
            trashed: false,
          }),
        } as any);

      await expect(
        provider.downloadStream('doc-file-1', { exportMimeType: 'image/png' })
      ).rejects.toThrow(/Unsupported export format 'image\/png' for Google Docs/);
    });
  });
});
