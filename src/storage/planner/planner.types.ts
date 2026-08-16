export interface MigrationStep {
  fileId: number;
  filename: string;
  sourceDriveId: number;
  sourceProviderFileId: string;
  destinationDriveId: number;
  fileSizeBytes: number;
}

export interface CapacityReservationRequirement {
  driveId: number;
  reservedBytes: number;
  reason: 'INCOMING_UPLOAD' | 'MIGRATION_DESTINATION';
}

export interface RejectedAlternative {
  targetDriveId: number;
  targetDriveEmail: string;
  reason:
    | 'INSUFFICIENT_SPACE'
    | 'UNAVAILABLE'
    | 'MIGRATION_LOCKED_CANNOT_EVACUATE'
    | 'NO_FEASIBLE_MIGRATION_DESTINATION'
    | 'FAILED_HEALTH';
  details?: string;
}

export interface StoragePlan {
  planId: string;
  operationType: 'UPLOAD' | 'PHYSICAL_MIGRATE' | 'DRIVE_RETIRE';
  targetDriveId: number;
  placementPolicy: 'MAX_USABLE_FREE_SPACE' | 'BALANCED_HEURISTIC' | 'MANUAL';
  requiresMigration: boolean;
  score: number;
  migrationSteps: MigrationStep[];
  capacityReservations: CapacityReservationRequirement[];
  expectedFinalState: {
    targetDriveUsableAfter: number;
    destinationDrivesUsableAfter: Record<number, number>;
  };
  rejectedAlternatives: RejectedAlternative[];
  rationale: string;
}

export interface PlannerOptions {
  cooldownPeriodMs?: number;
}
