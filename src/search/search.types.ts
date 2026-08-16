import { FileLifecycleStatus } from '../domain/types.js';

export interface SearchQuery {
  query?: string;
  parentId?: number | null;
  isFolder?: boolean;
  mimeType?: string;
  extension?: string;
  minSize?: number;
  maxSize?: number;
  googleAccountId?: number;
  lifecycleStatus?: FileLifecycleStatus;
  sortBy?: 'name' | 'size' | 'created_at' | 'updated_at';
  sortOrder?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface SearchResultItem {
  id: number;
  name: string;
  virtualPath: string;
  isFolder: boolean;
  mimeType: string;
  size: number;
  lifecycleStatus: string;
  googleAccountId?: number;
  googleAccountName?: string;
  checksum?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface FileProperties {
  fileId: number;
  name: string;
  virtualPath: string;
  isFolder: boolean;
  mimeType: string;
  size: number;
  lifecycleStatus: string;
  createdAt: number;
  updatedAt: number;
  lastAccessedAt: number | null;
  lastDownloadedAt: number | null;
  trashedAt: number | null;
  physicalLocation?: {
    locationId: number;
    googleAccountId: number;
    googleAccountEmail: string;
    googleAccountName: string;
    providerFileId: string;
    status: string;
    checksum: string | null;
    checksumType: string | null;
  };
}
