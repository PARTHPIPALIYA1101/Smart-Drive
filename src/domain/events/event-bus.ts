import { EventEmitter } from 'node:events';

export type SmartDriveEventType =
  | 'FILE_CREATED'
  | 'FILE_UPDATED'
  | 'FILE_MOVED'
  | 'FILE_TRASHED'
  | 'FILE_RESTORED'
  | 'FILE_DELETED'
  | 'FOLDER_CREATED'
  | 'UPLOAD_QUEUED'
  | 'UPLOAD_PROGRESS'
  | 'UPLOAD_COMPLETED'
  | 'UPLOAD_FAILED'
  | 'UPLOAD_CANCELLED'
  | 'DRIVE_STATUS_CHANGED'
  | 'DRIVE_QUOTA_UPDATED'
  | 'RECOVERY_COMPLETED';

export interface SmartDriveEvent<T = any> {
  id: string;
  type: SmartDriveEventType;
  payload: T;
  timestamp: number;
}

export type SmartDriveEventListener = (event: SmartDriveEvent) => void;

export class DomainEventBus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(200);
  }

  publish<T>(type: SmartDriveEventType, payload: T): SmartDriveEvent<T> {
    const event: SmartDriveEvent<T> = {
      id: `EVT-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
      type,
      payload,
      timestamp: Date.now(),
    };
    this.emitter.emit('event', event);
    this.emitter.emit(type, event);
    return event;
  }

  subscribeAll(listener: SmartDriveEventListener): () => void {
    this.emitter.on('event', listener);
    return () => {
      this.emitter.off('event', listener);
    };
  }

  subscribe(type: SmartDriveEventType, listener: SmartDriveEventListener): () => void {
    this.emitter.on(type, listener);
    return () => {
      this.emitter.off(type, listener);
    };
  }
}
