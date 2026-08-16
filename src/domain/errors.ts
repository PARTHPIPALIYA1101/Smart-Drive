export abstract class SmartDriveError extends Error {
  abstract readonly code: string;
  readonly isRecoverable: boolean;
  readonly metadata?: Record<string, unknown>;

  constructor(message: string, isRecoverable = false, metadata?: Record<string, unknown>) {
    super(message);
    this.name = this.constructor.name;
    this.isRecoverable = isRecoverable;
    this.metadata = metadata;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class InsufficientCapacityError extends SmartDriveError {
  readonly code = 'INSUFFICIENT_CAPACITY';
  constructor(message: string, metadata?: Record<string, unknown>) {
    super(message, false, metadata);
  }
}

export class ReservationConflictError extends SmartDriveError {
  readonly code = 'RESERVATION_CONFLICT';
  constructor(message: string, metadata?: Record<string, unknown>) {
    super(message, true, metadata);
  }
}

export class DriveUnavailableError extends SmartDriveError {
  readonly code = 'DRIVE_UNAVAILABLE';
  constructor(message: string, metadata?: Record<string, unknown>) {
    super(message, false, metadata);
  }
}

export class DriveMigrationLockedError extends SmartDriveError {
  readonly code = 'DRIVE_MIGRATION_LOCKED';
  constructor(message: string, metadata?: Record<string, unknown>) {
    super(message, false, metadata);
  }
}

export class HierarchyCycleError extends SmartDriveError {
  readonly code = 'HIERARCHY_CYCLE_DETECTED';
  constructor(message: string, metadata?: Record<string, unknown>) {
    super(message, false, metadata);
  }
}

export class EntityNotFoundError extends SmartDriveError {
  readonly code = 'ENTITY_NOT_FOUND';
  constructor(entity: string, id: string | number) {
    super(`${entity} with ID ${id} was not found`, false, { entity, id });
  }
}

export class VerificationFailedError extends SmartDriveError {
  readonly code = 'VERIFICATION_FAILED';
  constructor(message: string, metadata?: Record<string, unknown>) {
    super(message, false, metadata);
  }
}
