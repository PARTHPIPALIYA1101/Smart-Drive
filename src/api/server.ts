import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VirtualFilesystemService } from '../domain/vfs/vfs.service.js';
import { AccountService } from '../application/account/account.service.js';
import { CapacityService } from '../domain/capacity/capacity.service.js';
import { DriveSyncService } from '../application/sync/drive-sync.service.js';
import { TransferService } from '../domain/transfer/transfer.service.js';
import { StoragePlanner } from '../storage/planner/storage-planner.js';
import { MigrationPlanner } from '../storage/migration/migration-planner.js';
import { MigrationExecutor } from '../storage/migration/migration-executor.js';
import { CrashRecoveryEngine } from '../storage/recovery/recovery-engine.js';
import { SearchService } from '../search/search.service.js';
import { TransferProgressTracker } from '../domain/transfer/progress-tracker.js';
import { DriveRetirementService } from '../application/retirement/retirement.service.js';
import { StorageOperationRepository } from '../persistence/repositories/storage-operation.repository.js';
import { DriveImportService } from '../application/sync/drive-import.service.js';
import { StorageStatsService } from '../domain/stats/stats.service.js';
import { GoogleOAuthService } from '../providers/google-drive/auth/google-oauth.service.js';
import { DomainEventBus } from '../domain/events/event-bus.js';
import { UploadQueue } from '../domain/transfer/upload-queue.js';
import { TransferSessionManager } from '../domain/transfer/transfer-session-manager.js';
import { SmartDriveError } from '../domain/errors.js';

export interface AppServices {
  vfsService: VirtualFilesystemService;
  accountService: AccountService;
  oauthService: GoogleOAuthService;
  capacityService: CapacityService;
  statsService: StorageStatsService;
  driveSyncService: DriveSyncService;
  driveImportService: DriveImportService;
  transferService: TransferService;
  storagePlanner: StoragePlanner;
  migrationPlanner: MigrationPlanner;
  migrationExecutor: MigrationExecutor;
  recoveryEngine: CrashRecoveryEngine;
  searchService: SearchService;
  progressTracker: TransferProgressTracker;
  retirementService: DriveRetirementService;
  operationRepo: StorageOperationRepository;
  eventBus?: DomainEventBus;
  uploadQueue?: UploadQueue;
  sessionManager?: TransferSessionManager;
}

export function createServer(services: AppServices): FastifyInstance {
  const app = Fastify({ logger: false });

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const publicPath = path.resolve(__dirname, '../../public');

  app.register(cors, { origin: true });
  app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 * 1024 } }); // 50 GB stream limit
  app.register(fastifyStatic, {
    root: publicPath,
    prefix: '/',
  });

  const normalizeParentId = (val: any): number | null => {
    if (val === undefined || val === null || val === 'null' || val === '' || val === 0 || val === '0') {
      return null;
    }
    const parsed = typeof val === 'number' ? val : parseInt(val, 10);
    return Number.isNaN(parsed) || parsed === 0 ? null : parsed;
  };

  // Global Error Handler
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof SmartDriveError) {
      reply.status(400).send({
        success: false,
        error: {
          code: error.code,
          message: error.message,
          metadata: error.metadata,
        },
      });
      return;
    }

    const errObj = error as any;
    reply.status(500).send({
      success: false,
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: errObj?.message || 'An unexpected error occurred',
      },
    });
  });

  // ==========================================
  // Real-Time Event Stream (SSE)
  // ==========================================
  app.get('/api/events', async (req, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    // Send initial connection event
    reply.raw.write(`data: ${JSON.stringify({ type: 'CONNECTED', timestamp: Date.now() })}\n\n`);

    // Keep-alive heartbeat every 25 seconds
    const heartbeat = setInterval(() => {
      reply.raw.write(`: heartbeat\n\n`);
    }, 25000);

    let unsubscribe = () => {};
    if (services.eventBus) {
      unsubscribe = services.eventBus.subscribeAll((event) => {
        try {
          reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
        } catch {
          // Closed connection
        }
      });
    }

    req.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  // ==========================================
  // VFS Routes
  // ==========================================
  app.get('/api/vfs/tree', async (req, reply) => {
    const tree = services.vfsService.getTree();
    return reply.send({ success: true, data: tree });
  });

  app.get('/api/vfs/children', async (req, reply) => {
    const query = req.query as { parentId?: string; includeTrashed?: string };
    const parentId = normalizeParentId(query.parentId);
    const includeTrashed = query.includeTrashed === 'true';

    const children = services.vfsService.listChildren(parentId, includeTrashed);
    return reply.send({ success: true, data: children });
  });

  app.get('/api/vfs/nodes/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const node = services.vfsService.getNodeById(parseInt(id, 10));
    if (!node) {
      return reply.status(404).send({ success: false, error: { code: 'NOT_FOUND', message: 'Node not found' } });
    }
    return reply.send({ success: true, data: node });
  });

  app.post('/api/vfs/folders', async (req, reply) => {
    const body = req.body as { name: string; parentId: number | null };
    const parentId = normalizeParentId(body.parentId);
    const folder = services.vfsService.createFolder(parentId, body.name);
    return reply.status(201).send({ success: true, data: folder });
  });

  app.post('/api/vfs/folders/ensure-path', async (req, reply) => {
    const body = req.body as { parentId?: number | null; pathParts?: string[]; path?: string };
    const parentId = normalizeParentId(body.parentId);
    let parts: string[] = [];
    if (Array.isArray(body.pathParts)) {
      parts = body.pathParts;
    } else if (typeof body.path === 'string') {
      parts = body.path.replace(/\\/g, '/').split('/').filter(Boolean);
    }
    const folder = services.vfsService.ensureDirectoryPath(parentId, parts);
    return reply.send({ success: true, data: folder });
  });

  app.put('/api/vfs/nodes/:id/rename', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { newName: string };
    const updated = services.vfsService.renameNode(parseInt(id, 10), body.newName);
    return reply.send({ success: true, data: updated });
  });

  app.put('/api/vfs/nodes/:id/move', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { newParentId: number | null };
    const parentId = normalizeParentId(body.newParentId);
    const updated = services.vfsService.moveNode(parseInt(id, 10), parentId);
    return reply.send({ success: true, data: updated });
  });

  app.get('/api/vfs/trash', async (req, reply) => {
    const trashed = services.vfsService.listTrash();
    return reply.send({ success: true, data: trashed });
  });

  app.delete('/api/vfs/trash/empty', async (req, reply) => {
    const deletedCount = await services.transferService.emptyTrashPhysically();
    return reply.send({ success: true, data: { deletedCount } });
  });

  app.delete('/api/vfs/nodes/:id/trash', async (req, reply) => {
    const { id } = req.params as { id: string };
    const trashed = services.vfsService.trashNode(parseInt(id, 10));
    return reply.send({ success: true, data: trashed });
  });

  app.post('/api/vfs/trash/batch', async (req, reply) => {
    const body = req.body as { ids: number[] };
    const ids = Array.isArray(body?.ids) ? body.ids : [];
    let trashedCount = 0;
    for (const id of ids) {
      try {
        services.vfsService.trashNode(id);
        trashedCount++;
      } catch {
        // Continue if already trashed or missing
      }
    }
    return reply.send({ success: true, data: { trashedCount } });
  });

  app.post('/api/vfs/nodes/:id/restore', async (req, reply) => {
    const { id } = req.params as { id: string };
    const restored = services.vfsService.restoreNode(parseInt(id, 10));
    return reply.send({ success: true, data: restored });
  });

  app.post('/api/vfs/restore/batch', async (req, reply) => {
    const body = req.body as { ids: number[] };
    const ids = Array.isArray(body?.ids) ? body.ids : [];
    let restoredCount = 0;
    for (const id of ids) {
      try {
        services.vfsService.restoreNode(id);
        restoredCount++;
      } catch {
        // Continue
      }
    }
    return reply.send({ success: true, data: { restoredCount } });
  });

  app.delete('/api/vfs/nodes/:id/permanent', async (req, reply) => {
    const { id } = req.params as { id: string };
    const success = await services.transferService.deleteFilePhysically(parseInt(id, 10));
    return reply.send({ success });
  });

  app.post('/api/vfs/permanent/batch', async (req, reply) => {
    const body = req.body as { ids: number[] };
    const ids = Array.isArray(body?.ids) ? body.ids : [];
    let deletedCount = 0;
    for (const id of ids) {
      try {
        const deleted = await services.transferService.deleteFilePhysically(id);
        if (deleted) deletedCount++;
      } catch {
        // Continue
      }
    }
    return reply.send({ success: true, data: { deletedCount } });
  });

  // ==========================================
  // Transfer Routes (Upload, Download, Copy, Folder Plan)
  // ==========================================
  app.post('/api/transfer/folder/plan', async (req, reply) => {
    const body = req.body as any;
    const parentId = normalizeParentId(body.parentId);
    const plan = services.transferService.planFolderUpload({
      rootFolderName: body.rootFolderName,
      parentId,
      files: body.files || [],
    });
    return reply.send({ success: true, data: plan });
  });

  // Resumable upload endpoints (Option C: Browser-Session-Driven Resumable Uploads)
  app.post('/api/transfer/resumable/init', async (req, reply) => {
    const body = req.body as {
      name: string;
      parentId?: number | null;
      mimeType?: string;
      size: number;
      conflictAction?: any;
      relativePath?: string;
      batchId?: string;
    };

    const parentId = normalizeParentId(body.parentId);
    const result = await services.transferService.initResumableUpload({
      name: body.name,
      parentId,
      mimeType: body.mimeType || 'application/octet-stream',
      size: body.size || 0,
      conflictAction: body.conflictAction,
      relativePath: body.relativePath,
      batchId: body.batchId,
    });

    return reply.status(201).send({ success: true, data: result });
  });

  const handleResumableStream = async (req: any, reply: any) => {
    const { id } = req.params as { id: string };
    const query = (req.query || {}) as Record<string, any>;
    const startByte = parseInt(query.startByte || '0', 10);

    if (services.sessionManager) {
      services.sessionManager.handleReconnect(id);
    }

    const abortController = new AbortController();
    req.raw.on('close', () => {
      if (!req.raw.complete) {
        abortController.abort();
        if (services.sessionManager) {
          services.sessionManager.handleDisconnect(id);
        }
      }
    });

    try {
      const result = await services.transferService.resumeUploadStream({
        operationId: id,
        stream: req.raw,
        startByte,
        abortSignal: abortController.signal,
      });
      return reply.send({ success: true, data: result });
    } catch (err: any) {
      if (req.raw.destroyed || abortController.signal.aborted) {
        return reply.status(499).send({ success: false, error: { message: 'Client disconnected, session preserved' } });
      }
      throw err;
    }
  };

  app.put('/api/transfer/resumable/:id/stream', handleResumableStream);
  app.post('/api/transfer/resumable/:id/stream', handleResumableStream);

  app.get('/api/transfer/resumable/:id/offset', async (req, reply) => {
    const { id } = req.params as { id: string };
    const op = services.operationRepo.findById(id);
    if (!op) {
      return reply.status(404).send({ success: false, error: { message: 'Operation not found' } });
    }

    let planData: any = {};
    try {
      planData = op.planContext ? JSON.parse(op.planContext) : {};
    } catch {}

    let currentOffset = planData.bytesCompleted || 0;
    const destDriveId = op.destDriveId || planData.destDriveId;
    const sessionUri = planData.resumableSessionUri;
    const totalBytes = op.requestedBytes || planData.fileSize || 0;

    if (destDriveId && sessionUri && (services.transferService as any).providerFactory) {
      try {
        const provider = (services.transferService as any).providerFactory.getProvider(destDriveId);
        if (provider.queryResumableOffset) {
          currentOffset = await provider.queryResumableOffset(sessionUri, totalBytes);
          if (services.sessionManager) {
            services.sessionManager.updateProgress(id, currentOffset);
          }
        }
      } catch (err: any) {
        if (err.message?.includes('expired or invalid')) {
          return reply.status(410).send({
            success: false,
            error: { code: 'SESSION_EXPIRED', message: 'Upload session expired on provider' },
          });
        }
      }
    }

    return reply.send({
      success: true,
      data: {
        operationId: id,
        offset: currentOffset,
        fileSize: totalBytes,
        status: op.status,
        fileName: planData.fileName || 'Untitled',
        parentId: planData.parentId ?? null,
        relativePath: planData.relativePath || planData.fileName,
      },
    });
  });

  app.post('/api/transfer/resumable/:id/cancel', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (services.sessionManager) {
      await services.sessionManager.cancelUpload(id);
    } else {
      services.operationRepo.updateStatus(id, 'CANCELLED', 'USER_CANCELLED', 'Cancelled by user');
    }
    return reply.send({ success: true });
  });

  app.post('/api/operations/:id/reconnect', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (services.sessionManager) {
      services.sessionManager.handleReconnect(id);
    }
    return reply.send({ success: true });
  });

  app.post('/api/operations/reconnect', async (_req, reply) => {
    if (services.sessionManager) {
      services.sessionManager.handleReconnect();
    }
    return reply.send({ success: true });
  });

  app.post('/api/transfer/upload', async (req, reply) => {
    const query = (req.query || {}) as Record<string, any>;
    const data = await req.file();
    if (!data) {
      return reply.status(400).send({ success: false, error: { message: 'No file uploaded' } });
    }

    const fields = (data.fields || {}) as Record<string, any>;
    const parentId = normalizeParentId(fields.parentId?.value ?? query.parentId);
    const conflictAction = (fields.conflictAction?.value ?? query.conflictAction) as any;
    const declaredSize = parseInt(fields.size?.value ?? query.size ?? '0', 10);

    let stream: any = data.file;
    let size = declaredSize;

    if (size <= 0) {
      const chunks: Buffer[] = [];
      for await (const chunk of data.file) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const fullBuffer = Buffer.concat(chunks);
      size = fullBuffer.length;
      const { Readable } = await import('node:stream');
      stream = Readable.from(fullBuffer);
    }

    const result = await services.transferService.uploadFile({
      name: data.filename,
      parentId,
      mimeType: data.mimetype || 'application/octet-stream',
      size,
      stream,
      conflictAction,
    });

    return reply.status(201).send({ success: true, data: result });
  });

  app.post('/api/transfer/folder/queue', async (req, reply) => {
    const parts = req.files();
    const queuedFiles: Array<{
      filename: string;
      relativePath: string;
      parentId: number | null;
      size: number;
      mimeType: string;
      buffer: Buffer;
    }> = [];

    let rootFolderName = 'Uploaded Folder';
    let targetParentId: number | null = null;

    for await (const part of parts) {
      const chunks: Buffer[] = [];
      for await (const chunk of part.file) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const buffer = Buffer.concat(chunks);

      const fields = part.fields as Record<string, any>;
      const relPath = fields.relativePath?.value || part.filename;
      if (fields.rootFolderName?.value) rootFolderName = fields.rootFolderName.value;
      if (fields.parentId?.value) targetParentId = normalizeParentId(fields.parentId.value);

      queuedFiles.push({
        filename: part.filename,
        relativePath: relPath,
        parentId: targetParentId,
        size: buffer.length,
        mimeType: part.mimetype || 'application/octet-stream',
        buffer,
      });
    }

    if (!services.uploadQueue) {
      return reply.status(500).send({ success: false, error: { message: 'Upload queue not configured' } });
    }

    const batch = services.uploadQueue.enqueueBatch({
      rootFolderName,
      parentId: targetParentId,
      items: queuedFiles,
    });

    return reply.status(202).send({ success: true, data: batch });
  });

  app.get('/api/operations/active', async (req, reply) => {
    const activeBatches = services.uploadQueue ? services.uploadQueue.getActiveBatches() : [];
    const activeOps = services.operationRepo.findIncompleteOperations();
    const activeSessions = services.sessionManager ? services.sessionManager.getActiveSessions() : [];
    return reply.send({
      success: true,
      data: {
        activeBatches,
        activeOperations: activeOps,
        activeSessions: activeSessions.map((s) => ({
          operationId: s.operationId,
          fileName: s.fileName,
          relativePath: s.relativePath,
          fileSize: s.fileSize,
          bytesCompleted: s.bytesCompleted,
          status: s.status,
          destDriveId: s.destDriveId,
          parentId: s.parentId,
          resumableSessionUri: s.resumableSessionUri,
          batchId: s.batchId,
        })),
      },
    });
  });

  app.post('/api/transfer/batch/cancel', async (req, reply) => {
    const body = req.body as { batchId: string };
    if (!services.uploadQueue) {
      return reply.status(500).send({ success: false, error: { message: 'Upload queue not configured' } });
    }
    const cancelled = services.uploadQueue.cancelBatch(body.batchId);
    return reply.send({ success: cancelled });
  });

  app.get('/api/transfer/download/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const download = await services.transferService.downloadFile(parseInt(id, 10));

    let filename = download.file.name;
    let mimeType = download.mimeType;

    if (download.mimeType === 'application/vnd.google-apps.document') {
      mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      if (!filename.toLowerCase().endsWith('.docx')) filename += '.docx';
    } else if (download.mimeType === 'application/vnd.google-apps.spreadsheet') {
      mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      if (!filename.toLowerCase().endsWith('.xlsx')) filename += '.xlsx';
    } else if (download.mimeType === 'application/vnd.google-apps.presentation') {
      mimeType = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
      if (!filename.toLowerCase().endsWith('.pptx')) filename += '.pptx';
    } else if (download.mimeType === 'application/vnd.google-apps.drawing') {
      mimeType = 'image/png';
      if (!filename.toLowerCase().endsWith('.png')) filename += '.png';
    }

    reply.header('Content-Type', mimeType);
    reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    if (download.size && download.size > 0) {
      reply.header('Content-Length', download.size);
    }

    return reply.send(download.stream);
  });

  app.post('/api/transfer/copy', async (req, reply) => {
    const body = req.body as { fileId: number; targetParentId: number | null; newName?: string };
    const parentId = normalizeParentId(body.targetParentId);
    const result = await services.transferService.copyFile({ ...body, targetParentId: parentId });
    return reply.status(201).send({ success: true, data: result });
  });

  // ==========================================
  // Capacity & Statistics
  // ==========================================
  app.get('/api/capacity', async (req, reply) => {
    const report = services.capacityService.getUnifiedCapacityReport();
    return reply.send({ success: true, data: report });
  });

  app.get('/api/stats', async (req, reply) => {
    const stats = services.statsService.getStatistics();
    return reply.send({ success: true, data: stats });
  });

  app.post('/api/capacity/sync', async (req, reply) => {
    const report = await services.driveSyncService.syncAllAccounts();
    return reply.send({ success: true, data: report });
  });

  // ==========================================
  // Accounts Management & OAuth Callback
  // ==========================================
  app.get('/oauth2callback', async (req, reply) => {
    const query = req.query as { code?: string; error?: string };

    if (query.error) {
      reply.type('text/html').send(`
        <!DOCTYPE html>
        <html>
          <head><title>Authentication Failed</title></head>
          <body style="font-family:sans-serif; background:#0a0c10; color:#fff; display:flex; align-items:center; justify-content:center; height:100vh; text-align:center;">
            <div style="background:#181c26; padding:32px; border-radius:12px; border:1px solid rgba(255,255,255,0.1); max-width:480px;">
              <h2 style="color:#f43f5e; margin-bottom:12px;">Authentication Error</h2>
              <p style="color:#9ca3af; margin-bottom:20px;">${query.error}</p>
              <a href="/" style="color:#3b82f6; text-decoration:none; font-weight:600;">Return to Smart Drive</a>
            </div>
          </body>
        </html>
      `);
      return;
    }

    if (!query.code) {
      return reply.redirect('/');
    }

    try {
      const account = await services.accountService.connectAccount(query.code);
      try {
        await services.driveSyncService.syncAccountQuota(account.id);
      } catch {
        // Non-blocking initial quota sync
      }
      reply.type('text/html').send(`
        <!DOCTYPE html>
        <html>
          <head><title>Drive Connected</title></head>
          <body style="font-family:sans-serif; background:#0a0c10; color:#fff; display:flex; align-items:center; justify-content:center; height:100vh; text-align:center;">
            <div style="background:#181c26; padding:36px; border-radius:12px; border:1px solid rgba(255,255,255,0.1); max-width:480px;">
              <h2 style="color:#10b981; margin-bottom:12px;">✓ Google Drive Connected!</h2>
              <p style="color:#e5e7eb; font-weight:500; margin-bottom:6px;">${account.displayName}</p>
              <p style="color:#9ca3af; font-size:0.88rem; margin-bottom:20px;">${account.email}</p>
              <p style="color:#6b7280; font-size:0.8rem;">Redirecting back to Smart Drive...</p>
            </div>
            <script>
              if (window.opener) {
                window.opener.postMessage({ type: 'GOOGLE_DRIVE_CONNECTED' }, '*');
                setTimeout(() => window.close(), 1000);
              } else {
                setTimeout(() => { window.location.href = '/'; }, 1200);
              }
            </script>
          </body>
        </html>
      `);
    } catch (err: any) {
      reply.type('text/html').send(`
        <!DOCTYPE html>
        <html>
          <head><title>Connection Failed</title></head>
          <body style="font-family:sans-serif; background:#0a0c10; color:#fff; display:flex; align-items:center; justify-content:center; height:100vh; text-align:center;">
            <div style="background:#181c26; padding:32px; border-radius:12px; border:1px solid rgba(255,255,255,0.1); max-width:480px;">
              <h2 style="color:#f43f5e; margin-bottom:12px;">Failed to Connect Account</h2>
              <p style="color:#9ca3af; margin-bottom:20px;">${err?.message || 'An error occurred during account exchange.'}</p>
              <a href="/" style="color:#3b82f6; text-decoration:none; font-weight:600;">Return to Smart Drive</a>
            </div>
          </body>
        </html>
      `);
    }
  });

  app.get('/api/accounts/auth-url', async (req, reply) => {
    const authUrl = services.oauthService.generateAuthUrl();
    return reply.send({ success: true, data: { authUrl } });
  });

  app.get('/api/accounts', async (req, reply) => {
    const accounts = services.accountService.listAccounts();
    return reply.send({ success: true, data: accounts });
  });

  app.post('/api/accounts/connect', async (req, reply) => {
    const body = req.body as { code: string };
    const account = await services.accountService.connectAccount(body.code);
    try {
      await services.driveSyncService.syncAccountQuota(account.id);
    } catch {
      // Non-blocking initial sync
    }
    return reply.status(201).send({ success: true, data: account });
  });

  app.post('/api/accounts/:id/lock', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { locked: boolean };
    const account = services.accountService.setMigrationLock(parseInt(id, 10), body.locked);
    return reply.send({ success: true, data: account });
  });

  app.post('/api/accounts/:id/import', async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = await services.driveImportService.importAccountFiles(parseInt(id, 10));
    return reply.send({ success: true, data: result });
  });

  app.post('/api/accounts/import-all', async (req, reply) => {
    const results = await services.driveImportService.importAllAccounts();
    return reply.send({ success: true, data: results });
  });

  app.post('/api/accounts/:id/retire', async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = await services.retirementService.retireDrive(parseInt(id, 10));
    return reply.send({ success: true, data: result });
  });

  // ==========================================
  // Search & Properties
  // ==========================================
  app.get('/api/search', async (req, reply) => {
    const query = req.query as Record<string, any>;
    const parentId = normalizeParentId(query.parentId);
    const searchParams = {
      query: query.query,
      parentId: parentId ?? undefined,
      extension: query.extension,
      mimeType: query.mimeType,
      minSize: query.minSize ? parseInt(query.minSize, 10) : undefined,
      maxSize: query.maxSize ? parseInt(query.maxSize, 10) : undefined,
      sortBy: query.sortBy,
      sortOrder: query.sortOrder,
      limit: query.limit ? parseInt(query.limit, 10) : 50,
      offset: query.offset ? parseInt(query.offset, 10) : 0,
    };

    const results = services.searchService.search(searchParams);
    return reply.send({ success: true, data: results });
  });

  app.get('/api/search/properties/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const props = services.searchService.getFileProperties(parseInt(id, 10));
    return reply.send({ success: true, data: props });
  });

  // ==========================================
  // Operations & Progress (SSE)
  // ==========================================
  app.get('/api/operations/recent', async (req, reply) => {
    const ops = services.operationRepo.listRecent(50);
    return reply.send({ success: true, data: ops });
  });

  app.get('/api/operations/:id/progress', async (req, reply) => {
    const { id } = req.params as { id: string };

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const unsubscribe = services.progressTracker.subscribe(id, (event) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    });

    req.raw.on('close', () => {
      unsubscribe();
    });
  });

  return app;
}
