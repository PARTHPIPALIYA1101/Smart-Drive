import { Readable } from 'node:stream';
import { SmartFile, FileLocation, StorageOperation } from '../types.js';

export type UploadConflictAction = 'FAIL' | 'SKIP' | 'REPLACE' | 'RENAME';

export interface UploadFileInput {
  name: string;
  parentId: number | null;
  mimeType: string;
  size: number;
  stream: Readable;
  conflictAction?: UploadConflictAction;
}

export interface DownloadFileOutput {
  file: SmartFile;
  stream: Readable;
  mimeType: string;
  size: number;
}

export interface FileTransferResult {
  file: SmartFile;
  location: FileLocation;
  operation: StorageOperation;
  skipped?: boolean;
}

export interface CopyFileInput {
  fileId: number;
  targetParentId: number | null;
  newName?: string;
}

export interface FolderFileItem {
  relativePath: string; // e.g. "MyProject/src/main.java" or "src/main.java"
  size: number;
  mimeType?: string;
}

export interface FolderUploadPlanInput {
  rootFolderName: string;
  parentId: number | null;
  files: FolderFileItem[];
}

export interface FolderFilePlacement {
  relativePath: string;
  filename: string;
  size: number;
  mimeType: string;
  destDriveId: number;
  destDriveName: string;
}

export interface FolderUploadPlanResult {
  planId: string;
  rootFolderName: string;
  parentId: number | null;
  totalFiles: number;
  totalBytes: number;
  largestFileSize: number;
  placements: FolderFilePlacement[];
}
