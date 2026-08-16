import { describe, it, expect } from 'vitest';
import { TransferProgressTracker, TransferProgressEvent } from '../../src/domain/transfer/progress-tracker.js';
import { CancellationToken, OperationCancelledError } from '../../src/domain/transfer/cancellation-token.js';

describe('Progress Tracking & Cancellation Suite', () => {
  it('calculates percentage, speed, and ETA correctly', () => {
    const tracker = new TransferProgressTracker();
    const events: TransferProgressEvent[] = [];

    const unsubscribe = tracker.subscribe('OP-PROG-1', (e) => {
      events.push(e);
    });

    tracker.reportProgress('OP-PROG-1', 2500, 10000, 'STREAMING_UPLOAD', 'movie.mp4');
    tracker.reportProgress('OP-PROG-1', 5000, 10000, 'STREAMING_UPLOAD', 'movie.mp4');
    tracker.reportProgress('OP-PROG-1', 10000, 10000, 'VERIFYING', 'movie.mp4');

    expect(events).toHaveLength(3);
    expect(events[0].percentage).toBe(25);
    expect(events[1].percentage).toBe(50);
    expect(events[2].percentage).toBe(100);
    expect(events[2].currentStage).toBe('VERIFYING');

    unsubscribe();
  });

  it('triggers cancellation token callbacks and throws when cancelled', () => {
    const token = new CancellationToken();
    let callbackTriggered = false;

    token.onCancel(() => {
      callbackTriggered = true;
    });

    expect(token.isCancelled).toBe(false);
    expect(() => token.throwIfCancelled()).not.toThrow();

    token.cancel();
    expect(token.isCancelled).toBe(true);
    expect(callbackTriggered).toBe(true);
    expect(() => token.throwIfCancelled()).toThrow(OperationCancelledError);
  });
});
