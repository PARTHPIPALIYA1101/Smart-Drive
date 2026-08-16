export interface TransferProgressEvent {
  operationId: string;
  bytesTransferred: number;
  totalBytes: number;
  percentage: number;
  currentStage: string;
  currentFilename?: string;
  speedBytesPerSec: number;
  estimatedRemainingSeconds: number;
  timestamp: number;
}

export type ProgressListener = (event: TransferProgressEvent) => void;

export class TransferProgressTracker {
  private listeners = new Map<string, Set<ProgressListener>>();
  private startTimes = new Map<string, number>();
  private lastBytes = new Map<string, number>();

  subscribe(operationId: string, listener: ProgressListener): () => void {
    if (!this.listeners.has(operationId)) {
      this.listeners.set(operationId, new Set());
      this.startTimes.set(operationId, Date.now());
      this.lastBytes.set(operationId, 0);
    }

    this.listeners.get(operationId)!.add(listener);

    return () => {
      const set = this.listeners.get(operationId);
      if (set) {
        set.delete(listener);
        if (set.size === 0) {
          this.listeners.delete(operationId);
          this.startTimes.delete(operationId);
          this.lastBytes.delete(operationId);
        }
      }
    };
  }

  reportProgress(
    operationId: string,
    bytesTransferred: number,
    totalBytes: number,
    currentStage: string,
    currentFilename?: string
  ): void {
    const listeners = this.listeners.get(operationId);
    if (!listeners || listeners.size === 0) return;

    const now = Date.now();
    const startTime = this.startTimes.get(operationId) || now;
    const elapsedSeconds = Math.max(0.1, (now - startTime) / 1000);

    const speedBytesPerSec = Math.round(bytesTransferred / elapsedSeconds);
    const remainingBytes = Math.max(0, totalBytes - bytesTransferred);
    const estimatedRemainingSeconds =
      speedBytesPerSec > 0 ? Math.round(remainingBytes / speedBytesPerSec) : 0;
    const percentage =
      totalBytes > 0 ? Math.min(100, Math.round((bytesTransferred / totalBytes) * 100)) : 0;

    const event: TransferProgressEvent = {
      operationId,
      bytesTransferred,
      totalBytes,
      percentage,
      currentStage,
      currentFilename,
      speedBytesPerSec,
      estimatedRemainingSeconds,
      timestamp: now,
    };

    listeners.forEach((listener) => {
      try {
        listener(event);
      } catch {
        // Safe listener error boundary
      }
    });
  }
}
