import { SmartFile } from '../types.js';

export interface VirtualTreeNode {
  id: number;
  name: string;
  parentId: number | null;
  isFolder: boolean;
  size: number;
  mimeType: string;
  lifecycleStatus: string;
  virtualPath: string;
  children?: VirtualTreeNode[];
}

export interface CreateFolderParams {
  name: string;
  parentId: number | null;
}

export interface RenameNodeParams {
  id: number;
  newName: string;
}

export interface MoveNodeParams {
  id: number;
  newParentId: number | null;
}

export interface FileItemWithLocation extends SmartFile {
  virtualPath: string;
  physicalLocation?: {
    googleAccountId: number;
    providerFileId: string;
    status: string;
    checksum: string | null;
  };
}
