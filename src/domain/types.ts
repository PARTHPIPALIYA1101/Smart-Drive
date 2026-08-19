export type FileLifecycleStatus = 'PENDING' | 'ACTIVE' | 'TRASHED' | 'FAILED';

export type DriveStatus = 'AVAILABLE' | 'DEGRADED' | 'UNAVAILABLE' | 'DISCONNECTED';

export type LocationStatus = 'ACTIVE' | 'COPYING' | 'VERIFIED' | 'OLD' | 'ORPHAN_CLEANUP';

export type OperationType =
  | 'UPLOAD'
  | 'DOWNLOAD'
  | 'COPY'
  | 'VIRTUAL_MOVE'
  | 'PHYSICAL_MIGRATE'
  | 'DELETE_TRASH'
  | 'PERMANENT_DELETE'
  | 'RESTORE'
  | 'DRIVE_RETIRE';

export type OperationStatus =
  | 'PENDING'
  | 'RESERVED'
  | 'EXECUTING'
  | 'WAITING_FOR_SOURCE'
  | 'VERIFYING'
  | 'SWITCHING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'RECOVERY_REQUIRED';

export type ReservationStatus = 'ACTIVE' | 'COMMITTED' | 'RELEASED' | 'EXPIRED';

export type MigrationStatus = 'IN_PROGRESS' | 'VERIFIED' | 'COMPLETED' | 'FAILED' | 'ABORTED';

export type MigrationReason = 'CAPACITY_REBALANCE' | 'DRIVE_RETIREMENT' | 'MANUAL_REQUEST';

export type ChecksumType = 'MD5' | 'SHA256' | 'PROVIDER_HASH' | 'NONE';

export interface SmartFile {
  id: number;
  name: string;
  parentId: number | null;
  isFolder: boolean;
  mimeType: string;
  size: number;
  lifecycleStatus: FileLifecycleStatus;
  createdAt: number;
  updatedAt: number;
  lastAccessedAt: number | null;
  lastDownloadedAt: number | null;
  trashedAt: number | null;
}

export interface GoogleAccount {
  id: number;
  email: string;
  displayName: string;
  totalSpace: number;
  usedSpace: number;
  freeSpace: number;
  reservedBytes: number;
  migrationLocked: boolean;
  status: DriveStatus;
  encryptedCredentials: string;
  lastSyncedAt: number | null;
  consecutiveFailures: number;
  createdAt: number;
  updatedAt: number;
}

export interface FileLocation {
  id: number;
  fileId: number;
  googleAccountId: number;
  providerFileId: string;
  status: LocationStatus;
  size: number;
  mimeType: string;
  checksum: string | null;
  checksumType: ChecksumType | null;
  createdAt: number;
  migratedAt: number | null;
}

export interface StorageOperation {
  id: string;
  operationType: OperationType;
  fileId: number | null;
  sourceDriveId: number | null;
  destDriveId: number | null;
  requestedBytes: number;
  status: OperationStatus;
  errorCode: string | null;
  errorMessage: string | null;
  planContext: string | null;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

export interface StorageReservation {
  id: number;
  googleAccountId: number;
  operationId: string;
  reservedBytes: number;
  status: ReservationStatus;
  expiresAt: number;
  createdAt: number;
}

export interface FileMigration {
  id: number;
  operationId: string;
  fileId: number;
  sourceDriveId: number;
  sourceProviderFileId: string;
  destDriveId: number;
  destProviderFileId: string | null;
  reason: MigrationReason;
  bytesTransferred: number;
  status: MigrationStatus;
  startedAt: number;
  completedAt: number | null;
}
