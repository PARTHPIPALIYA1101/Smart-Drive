export class OperationCancelledError extends Error {
  readonly code = 'OPERATION_CANCELLED';
  constructor(message = 'The operation was cancelled by user request') {
    super(message);
    this.name = 'OperationCancelledError';
  }
}

export class CancellationToken {
  private _isCancelled = false;
  private cancelCallbacks: Array<() => void> = [];

  get isCancelled(): boolean {
    return this._isCancelled;
  }

  cancel(): void {
    if (this._isCancelled) return;
    this._isCancelled = true;
    this.cancelCallbacks.forEach((cb) => {
      try {
        cb();
      } catch {
        // Safe callback boundary
      }
    });
  }

  onCancel(callback: () => void): void {
    if (this._isCancelled) {
      callback();
    } else {
      this.cancelCallbacks.push(callback);
    }
  }

  throwIfCancelled(): void {
    if (this._isCancelled) {
      throw new OperationCancelledError();
    }
  }
}
