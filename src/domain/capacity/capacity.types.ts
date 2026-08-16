import { DriveStatus } from '../types.js';

export interface DriveCapacitySnapshot {
  accountId: number;
  email: string;
  displayName: string;
  status: DriveStatus;
  totalSpace: number;
  usedSpace: number;
  freeSpace: number;
  reservedBytes: number;
  activeReservations: number;
  usableSpace: number;
  migrationLocked: boolean;
  lastSyncedAt: number | null;
}

export interface UnifiedCapacityReport {
  totalUnifiedBytes: number;
  totalUsedBytes: number;
  totalFreeBytes: number;
  totalUsableBytes: number;
  largestSingleFileCapacity: number;
  connectedDrivesCount: number;
  availableDrivesCount: number;
  degradedDrivesCount: number;
  unavailableDrivesCount: number;
  migrationLockedDrivesCount: number;
  drives: DriveCapacitySnapshot[];
}
