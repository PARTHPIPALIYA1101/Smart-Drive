import { StorageOperationRepository } from '../../persistence/repositories/storage-operation.repository.js';
import { StorageReservationRepository } from '../../persistence/repositories/storage-reservation.repository.js';
import { IProviderFactory } from '../../providers/provider-factory.js';
import { DomainEventBus } from '../events/event-bus.js';
import { ResourceLimits } from '../../config/resource-limits.js';
import { OperationStatus } from '../types.js';

export interface ActiveUploadSession {
  operationId: string;
  destDriveId: number;
  fileName: string;
  relativePath: string;
  parentId: number | null;
  fileSize: number;
  mimeType: string;
  bytesCompleted: number;
  resumableSessionUri?: string;
  smartFileId?: number;
  rootSmartFileId?: number | null;
  sourceType?: 'FILE' | 'FOLDER';
  sourcePath?: string;
  status: OperationStatus;
  abortController: AbortController;
  disconnectTimer?: NodeJS.Timeout;
  lastActiveAt: number;
  isConnected: boolean;
  batchId?: string;
  conflictAction?: string;
}

export class TransferSessionManager {
  private sessions = new Map<string, ActiveUploadSession>();
  private lastPersistTime = new Map<string, number>();

  constructor(
    private operationRepo: StorageOperationRepository,
    private reservationRepo: StorageReservationRepository,
    private providerFactory: IProviderFactory,
    private eventBus?: DomainEventBus,
    private disconnectGracePeriodMs = ResourceLimits.DISCONNECT_GRACE_PERIOD_MS
  ) {}

  /**
   * Initializes or registers an active upload session.
   */
  registerSession(data: {
    operationId: string;
    destDriveId: number;
    fileName: string;
    relativePath: string;
    parentId: number | null;
    fileSize: number;
    mimeType: string;
    resumableSessionUri?: string;
    smartFileId?: number;
    rootSmartFileId?: number | null;
    sourceType?: 'FILE' | 'FOLDER';
    sourcePath?: string;
    batchId?: string;
    conflictAction?: string;
    bytesCompleted?: number;
  }): ActiveUploadSession {
    const existing = this.sessions.get(data.operationId);
    if (existing) {
      if (data.resumableSessionUri) existing.resumableSessionUri = data.resumableSessionUri;
      if (data.smartFileId) existing.smartFileId = data.smartFileId;
      if (data.rootSmartFileId !== undefined) existing.rootSmartFileId = data.rootSmartFileId;
      if (data.sourcePath) existing.sourcePath = data.sourcePath;
      if (data.sourceType) existing.sourceType = data.sourceType;
      existing.lastActiveAt = Date.now();
      existing.isConnected = true;
      if (existing.disconnectTimer) {
        clearTimeout(existing.disconnectTimer);
        delete existing.disconnectTimer;
      }
      return existing;
    }

    const session: ActiveUploadSession = {
      operationId: data.operationId,
      destDriveId: data.destDriveId,
      fileName: data.fileName,
      relativePath: data.relativePath,
      parentId: data.parentId,
      fileSize: data.fileSize,
      mimeType: data.mimeType,
      bytesCompleted: data.bytesCompleted || 0,
      resumableSessionUri: data.resumableSessionUri,
      smartFileId: data.smartFileId,
      rootSmartFileId: data.rootSmartFileId,
      sourceType: data.sourceType,
      sourcePath: data.sourcePath,
      status: 'EXECUTING',
      abortController: new AbortController(),
      lastActiveAt: Date.now(),
      isConnected: true,
      batchId: data.batchId,
      conflictAction: data.conflictAction,
    };

    this.sessions.set(data.operationId, session);
    return session;
  }

  /**
   * Retrieves an active session by operation ID.
   */
  getSession(operationId: string): ActiveUploadSession | undefined {
    return this.sessions.get(operationId);
  }

  /**
   * Returns all currently active / resumable upload sessions.
   */
  getActiveSessions(): ActiveUploadSession[] {
    return Array.from(this.sessions.values()).filter(
      (s) =>
        s.status === 'EXECUTING' ||
        s.status === 'RESERVED' ||
        s.status === 'WAITING_FOR_SOURCE' ||
        s.status === 'VERIFYING'
    );
  }

  /**
   * Reports upload progress in-memory and throttles SQLite updates.
   */
  updateProgress(operationId: string, bytesCompleted: number): void {
    const session = this.sessions.get(operationId);
    if (!session) return;

    session.bytesCompleted = bytesCompleted;
    session.lastActiveAt = Date.now();

    const now = Date.now();
    const lastTime = this.lastPersistTime.get(operationId) || 0;

    if (now - lastTime >= ResourceLimits.PROGRESS_PERSIST_INTERVAL || bytesCompleted >= session.fileSize) {
      this.lastPersistTime.set(operationId, now);
      this.persistSessionState(session);
    }
  }

  /**
   * Invoked when client socket disconnects. Starts disconnect grace period timer.
   */
  handleDisconnect(operationId: string): void {
    const session = this.sessions.get(operationId);
    if (!session || session.status === 'COMPLETED' || session.status === 'CANCELLED' || session.status === 'FAILED') {
      return;
    }

    session.isConnected = false;

    if (!session.disconnectTimer) {
      session.disconnectTimer = setTimeout(() => {
        this.onGracePeriodExpired(operationId);
      }, this.disconnectGracePeriodMs);
    }
  }

  /**
   * Invoked when client reconnects (e.g. after browser refresh or SSE reconnect).
   */
  handleReconnect(operationId?: string): void {
    if (operationId) {
      const session = this.sessions.get(operationId);
      if (session) {
        session.isConnected = true;
        if (session.disconnectTimer) {
          clearTimeout(session.disconnectTimer);
          delete session.disconnectTimer;
        }
        if (session.status === 'WAITING_FOR_SOURCE') {
          session.status = 'EXECUTING';
        }
      }
    } else {
      // Reconnected globally (e.g. SSE open): clear grace timers on all active sessions
      for (const session of this.sessions.values()) {
        session.isConnected = true;
        if (session.disconnectTimer) {
          clearTimeout(session.disconnectTimer);
          delete session.disconnectTimer;
        }
      }
    }
  }

  /**
   * Marks an operation as waiting for the browser to re-provide the source file.
   */
  markWaitingForSource(operationId: string): void {
    const session = this.sessions.get(operationId);
    if (!session) return;

    if (session.disconnectTimer) {
      clearTimeout(session.disconnectTimer);
      delete session.disconnectTimer;
    }

    session.status = 'WAITING_FOR_SOURCE';
    this.operationRepo.updateStatus(operationId, 'WAITING_FOR_SOURCE');
    this.persistSessionState(session);
    this.eventBus?.publish('UPLOAD_PROGRESS', {
      operationId,
      status: 'WAITING_FOR_SOURCE',
      filename: session.fileName,
      bytesCompleted: session.bytesCompleted,
      fileSize: session.fileSize,
    });
  }

  /**
   * Invoked when the disconnect grace period expires without browser reconnection.
   */
  async onGracePeriodExpired(operationId: string): Promise<void> {
    const session = this.sessions.get(operationId);
    if (!session || session.status === 'COMPLETED' || session.status === 'CANCELLED') {
      return;
    }

    // 1. Abort local stream controller
    session.abortController.abort();
    session.status = 'CANCELLED';

    // 2. Abort provider resumable session if exists
    if (session.resumableSessionUri) {
      try {
        const provider = this.providerFactory.getProvider(session.destDriveId);
        if (provider.abortSession) {
          await provider.abortSession(session.resumableSessionUri);
        }
      } catch {
        // Best-effort provider abort
      }
    }

    // 3. Release SQLite capacity reservations
    try {
      this.reservationRepo.releaseByOperationId(operationId);
    } catch {
      // Best-effort release
    }

    // 4. Update SQLite status to CANCELLED
    this.operationRepo.updateStatus(
      operationId,
      'CANCELLED',
      'DISCONNECT_GRACE_EXPIRED',
      'Client disconnected and did not reconnect within grace period'
    );

    this.eventBus?.publish('UPLOAD_CANCELLED', { operationId, reason: 'DISCONNECT_GRACE_EXPIRED' });
    this.sessions.delete(operationId);
    this.lastPersistTime.delete(operationId);
  }

  /**
   * Explicitly cancels an upload.
   */
  async cancelUpload(operationId: string): Promise<boolean> {
    const session = this.sessions.get(operationId);
    if (session) {
      if (session.disconnectTimer) {
        clearTimeout(session.disconnectTimer);
      }
      session.abortController.abort();
      session.status = 'CANCELLED';

      if (session.resumableSessionUri) {
        try {
          const provider = this.providerFactory.getProvider(session.destDriveId);
          if (provider.abortSession) {
            await provider.abortSession(session.resumableSessionUri);
          }
        } catch {}
      }

      this.sessions.delete(operationId);
    }

    this.reservationRepo.releaseByOperationId(operationId);
    this.operationRepo.updateStatus(operationId, 'CANCELLED', 'USER_CANCELLED', 'Cancelled by user');
    this.eventBus?.publish('UPLOAD_CANCELLED', { operationId });
    return true;
  }

  /**
   * Marks session completed and frees session tracking memory.
   */
  completeSession(operationId: string): void {
    const session = this.sessions.get(operationId);
    if (session) {
      if (session.disconnectTimer) {
        clearTimeout(session.disconnectTimer);
      }
      session.status = 'COMPLETED';
      this.sessions.delete(operationId);
    }
    this.lastPersistTime.delete(operationId);
  }

  private persistSessionState(session: ActiveUploadSession): void {
    try {
      this.operationRepo.updatePlanContext(
        session.operationId,
        JSON.stringify({
          sourceType: session.sourceType,
          sourcePath: session.sourcePath,
          fileName: session.fileName,
          relativePath: session.relativePath,
          parentId: session.parentId,
          rootSmartFileId: session.rootSmartFileId,
          fileSize: session.fileSize,
          mimeType: session.mimeType,
          bytesCompleted: session.bytesCompleted,
          destDriveId: session.destDriveId,
          resumableSessionUri: session.resumableSessionUri,
          smartFileId: session.smartFileId,
          batchId: session.batchId,
          conflictAction: session.conflictAction,
        })
      );
    } catch {
      // Non-blocking planContext update
    }
  }

  cleanup(): void {
    for (const session of this.sessions.values()) {
      if (session.disconnectTimer) {
        clearTimeout(session.disconnectTimer);
      }
    }
    this.sessions.clear();
  }

  destroy(): void {
    this.cleanup();
  }
}
