import { MigrationReason } from '../../domain/types.js';
import { MigrationStep, CapacityReservationRequirement } from '../planner/planner.types.js';

export interface EvacuationPlan {
  planId: string;
  sourceDriveId: number;
  reason: MigrationReason;
  migrationSteps: MigrationStep[];
  unmigratableFiles: Array<{
    fileId: number;
    filename: string;
    size: number;
    reason: string;
  }>;
  totalBytesToTransfer: number;
  capacityReservations: CapacityReservationRequirement[];
  isFullyEvacuatable: boolean;
}

export interface ManualMigrationPlan {
  planId: string;
  fileId: number;
  filename: string;
  sourceDriveId: number;
  sourceProviderFileId: string;
  destinationDriveId: number;
  fileSizeBytes: number;
  capacityReservation: CapacityReservationRequirement;
}
