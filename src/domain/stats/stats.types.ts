import { DriveStatus } from '../types.js';

export interface DriveStorageStats {
  accountId: number;
  displayName: string;
  email: string;
  status: DriveStatus;
  migrationLocked: boolean;
  totalCapacity: number;
  usedCapacity: number;
  freeCapacity: number;
  reservedCapacity: number;
  usableCapacity: number;
  fileCount: number;
  failedOperationsCount: number;
  lastSyncedAt: number | null;
}

export interface StorageStatisticsReport {
  // Global Logical Storage (What the user logically owns)
  totalLogicalBytes: number;
  totalFiles: number;
  totalFolders: number;
  totalTrashItems: number;

  // Global Physical Storage (What providers physically store)
  totalPhysicalBytes: number;
  totalCapacityBytes: number;
  totalFreeBytes: number;
  totalUsableBytes: number;

  // Operation Physical Transfer Totals
  totalUploadedBytes: number;
  totalDownloadedBytes: number;
  totalMigratedBytes: number;

  // Per-Drive Breakdown
  drives: DriveStorageStats[];
}
