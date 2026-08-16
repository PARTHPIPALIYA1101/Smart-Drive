import { FileRepository } from '../../persistence/repositories/file.repository.js';
import { SmartFile } from '../types.js';
import { VirtualTreeNode } from './vfs.types.js';
import { PathUtils } from './path-utils.js';
import { DomainEventBus } from '../events/event-bus.js';
import {
  EntityNotFoundError,
  HierarchyCycleError,
  SmartDriveError,
} from '../errors.js';

export class DuplicateSiblingError extends SmartDriveError {
  readonly code = 'DUPLICATE_SIBLING_NAME';
  constructor(name: string, parentId: number | null) {
    super(
      `An item named "${name}" already exists in the destination folder (${parentId ?? 'root'})`,
      false,
      { name, parentId }
    );
  }
}

export class InvalidParentError extends SmartDriveError {
  readonly code = 'INVALID_PARENT_FOLDER';
  constructor(message: string) {
    super(message, false);
  }
}

export class VirtualFilesystemService {
  constructor(
    private fileRepo: FileRepository,
    private eventBus?: DomainEventBus
  ) {}

  private normalizeParentId(parentId: number | null | undefined): number | null {
    if (parentId === 0 || parentId === undefined || parentId === null || Number.isNaN(parentId)) {
      return null;
    }
    return parentId;
  }

  /**
   * Creates a new virtual folder.
   */
  createFolder(parentId: number | null, name: string): SmartFile {
    const normParentId = this.normalizeParentId(parentId);
    const validName = PathUtils.validateNodeName(name);

    if (normParentId !== null) {
      const parent = this.fileRepo.findById(normParentId);
      if (!parent) {
        throw new EntityNotFoundError('Parent folder', normParentId);
      }
      if (!parent.isFolder) {
        throw new InvalidParentError(`Parent ID ${normParentId} is a file, not a folder`);
      }
      if (parent.lifecycleStatus !== 'ACTIVE') {
        throw new InvalidParentError(`Parent folder ${normParentId} is not active (status: ${parent.lifecycleStatus})`);
      }
    }

    // Check sibling duplicate name
    this.assertNoSiblingConflict(validName, normParentId);

    const now = Date.now();
    const folder = this.fileRepo.insert({
      name: validName,
      parentId: normParentId,
      isFolder: true,
      mimeType: 'application/x-directory',
      size: 0,
      lifecycleStatus: 'ACTIVE',
      createdAt: now,
      updatedAt: now,
    });

    this.eventBus?.publish('FOLDER_CREATED', folder);
    this.eventBus?.publish('FILE_CREATED', folder);

    return folder;
  }

  /**
   * Finds an active child node under a parent by its name (case-insensitive).
   */
  findChildByName(parentId: number | null, name: string): SmartFile | null {
    const normParentId = this.normalizeParentId(parentId);
    const siblings = this.fileRepo.findActiveByParentId(normParentId);
    return siblings.find((s) => s.name.toLowerCase() === name.trim().toLowerCase()) ?? null;
  }

  /**
   * Idempotently ensures that a nested virtual directory path exists.
   * Example: pathParts = ["MyProject", "src", "utils"]
   * Creates any missing intermediate folders and returns the leaf folder node.
   */
  ensureDirectoryPath(rootParentId: number | null, pathParts: string[]): SmartFile {
    let currentParentId = this.normalizeParentId(rootParentId);
    let lastFolder: SmartFile | null = null;

    for (const part of pathParts) {
      const cleanName = part.trim();
      if (!cleanName) continue;

      let existing = this.findChildByName(currentParentId, cleanName);
      if (existing) {
        if (!existing.isFolder) {
          throw new InvalidParentError(`Cannot create folder "${cleanName}" because a file with that name already exists`);
        }
        lastFolder = existing;
        currentParentId = existing.id;
      } else {
        try {
          lastFolder = this.createFolder(currentParentId, cleanName);
          currentParentId = lastFolder.id;
        } catch (err) {
          if (err instanceof DuplicateSiblingError) {
            // Concurrency race: another worker created the folder at the same instant
            const refetched = this.findChildByName(currentParentId, cleanName);
            if (refetched && refetched.isFolder) {
              lastFolder = refetched;
              currentParentId = refetched.id;
            } else {
              throw err;
            }
          } else {
            throw err;
          }
        }
      }
    }

    if (!lastFolder) {
      const normRoot = this.normalizeParentId(rootParentId);
      if (normRoot !== null) {
        const root = this.fileRepo.findById(normRoot);
        if (root) return root;
      }
      // If rootParentId is null and pathParts was empty, return virtual root placeholder
      return {
        id: 0,
        name: 'Smart Drive',
        parentId: null,
        isFolder: true,
        mimeType: 'application/x-directory',
        size: 0,
        lifecycleStatus: 'ACTIVE',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        lastAccessedAt: null,
        lastDownloadedAt: null,
        trashedAt: null,
      };
    }

    return lastFolder;
  }

  /**
   * Renames a virtual file or folder.
   */
  renameNode(id: number, newName: string): SmartFile {
    const validName = PathUtils.validateNodeName(newName);
    const node = this.fileRepo.findById(id);

    if (!node) {
      throw new EntityNotFoundError('Node', id);
    }

    if (node.name === validName) {
      return node;
    }

    // Check sibling duplicate name
    this.assertNoSiblingConflict(validName, node.parentId, id);

    const updated = this.fileRepo.update(id, { name: validName });
    if (!updated) {
      throw new EntityNotFoundError('Node', id);
    }

    this.eventBus?.publish('FILE_UPDATED', updated);
    return updated;
  }

  /**
   * Moves a virtual file or folder to a new parent folder.
   * Strictly verifies that a folder cannot become its own ancestor.
   */
  moveNode(id: number, newParentId: number | null): SmartFile {
    const normNewParentId = this.normalizeParentId(newParentId);
    const node = this.fileRepo.findById(id);
    if (!node) {
      throw new EntityNotFoundError('Node', id);
    }

    if (node.parentId === normNewParentId) {
      return node; // No-op
    }

    if (normNewParentId !== null) {
      const targetParent = this.fileRepo.findById(normNewParentId);
      if (!targetParent) {
        throw new EntityNotFoundError('Destination folder', normNewParentId);
      }
      if (!targetParent.isFolder) {
        throw new InvalidParentError(`Destination ID ${normNewParentId} is a file, not a folder`);
      }
      if (targetParent.lifecycleStatus !== 'ACTIVE') {
        throw new InvalidParentError(
          `Destination folder ${normNewParentId} is not active (status: ${targetParent.lifecycleStatus})`
        );
      }

      // Hierarchy Cycle Prevention
      if (node.isFolder) {
        if (normNewParentId === id) {
          throw new HierarchyCycleError(`Cannot move folder ID ${id} into itself`);
        }

        const ancestorIds = this.fileRepo.getAncestorIds(normNewParentId);
        if (ancestorIds.includes(id)) {
          throw new HierarchyCycleError(
            `Cannot move folder ID ${id} into one of its own subfolders (Target: ${normNewParentId})`
          );
        }
      }
    }

    // Check sibling duplicate name in destination
    this.assertNoSiblingConflict(node.name, normNewParentId, id);

    const updated = this.fileRepo.update(id, { parentId: normNewParentId });
    if (!updated) {
      throw new EntityNotFoundError('Node', id);
    }

    this.eventBus?.publish('FILE_MOVED', { node: updated, previousParentId: node.parentId, newParentId: normNewParentId });
    return updated;
  }

  /**
   * Resolves a node by its permanent Smart File ID.
   */
  getNodeById(id: number): SmartFile | null {
    const node = this.fileRepo.findById(id);
    return node ?? null;
  }

  /**
   * Resolves full virtual absolute path for a node by traversing upwards to root.
   */
  getAbsolutePath(id: number): string {
    const node = this.fileRepo.findById(id);
    if (!node) {
      throw new EntityNotFoundError('Node', id);
    }

    const segments: string[] = [node.name];
    let currentParentId = node.parentId;

    while (currentParentId !== null) {
      const parent = this.fileRepo.findById(currentParentId);
      if (!parent) {
        break;
      }
      segments.unshift(parent.name);
      currentParentId = parent.parentId;
    }

    return '/' + segments.join('/');
  }

  /**
   * Resolves a node by its virtual path (e.g. "/Projects/Backend/app.zip").
   */
  getNodeByPath(virtualPath: string): SmartFile | null {
    const segments = PathUtils.splitPath(virtualPath);
    if (segments.length === 0) {
      return null;
    }

    let currentParentId: number | null = null;
    let currentNode: SmartFile | null = null;

    for (let i = 0; i < segments.length; i++) {
      const segmentName = segments[i];
      const siblings = this.fileRepo.findActiveByParentId(currentParentId);
      const match = siblings.find((s) => s.name.toLowerCase() === segmentName.toLowerCase());

      if (!match) {
        return null;
      }

      currentNode = match;
      currentParentId = match.id;
    }

    return currentNode;
  }

  /**
   * Lists all children in a virtual folder.
   */
  listChildren(parentId: number | null, includeTrashed = false): SmartFile[] {
    const normParentId = this.normalizeParentId(parentId);
    if (includeTrashed) {
      return this.fileRepo.findByParentId(normParentId);
    }
    return this.fileRepo.findActiveByParentId(normParentId);
  }

  /**
   * Builds full virtual tree hierarchy starting from root or specific folder.
   */
  getTree(rootId: number | null = null): VirtualTreeNode {
    const normRootId = this.normalizeParentId(rootId);
    if (normRootId === null) {
      const rootChildren = this.fileRepo.findActiveByParentId(null);
      return {
        id: 0,
        name: 'Smart Drive',
        parentId: null,
        isFolder: true,
        size: 0,
        mimeType: 'application/x-directory',
        lifecycleStatus: 'ACTIVE',
        virtualPath: '/',
        children: rootChildren.map((child) => this.buildSubtree(child, '/')),
      };
    }

    const rootNode = this.fileRepo.findById(normRootId);
    if (!rootNode) {
      throw new EntityNotFoundError('Folder', normRootId);
    }

    const currentPath = this.getAbsolutePath(normRootId);
    return this.buildSubtree(rootNode, currentPath);
  }

  private buildSubtree(node: SmartFile, parentPath: string): VirtualTreeNode {
    const virtualPath =
      parentPath === '/' ? `/${node.name}` : `${parentPath}/${node.name}`;

    const treeNode: VirtualTreeNode = {
      id: node.id,
      name: node.name,
      parentId: node.parentId,
      isFolder: node.isFolder,
      size: node.size,
      mimeType: node.mimeType,
      lifecycleStatus: node.lifecycleStatus,
      virtualPath,
    };

    if (node.isFolder) {
      const children = this.fileRepo.findActiveByParentId(node.id);
      treeNode.children = children.map((child) => this.buildSubtree(child, virtualPath));
    }

    return treeNode;
  }

  /**
   * Moves a file or folder to the trash.
   * If node is a folder, recursively cascades trash status to all descendants.
   */
  trashNode(id: number): SmartFile {
    const node = this.fileRepo.findById(id);
    if (!node) {
      throw new EntityNotFoundError('Node', id);
    }

    if (node.lifecycleStatus === 'TRASHED') {
      return node; // Idempotent
    }

    if (node.isFolder) {
      this.fileRepo.trashRecursive(id);
    } else {
      this.fileRepo.trash(id);
    }

    const trashed = this.fileRepo.findById(id)!;
    this.eventBus?.publish('FILE_TRASHED', trashed);
    return trashed;
  }

  /**
   * Restores a file or folder from the trash.
   * If parent was trashed/deleted, safely re-parents to root.
   * If node is a folder, recursively restores descendants.
   */
  restoreNode(id: number): SmartFile {
    const node = this.fileRepo.findById(id);
    if (!node) {
      throw new EntityNotFoundError('Node', id);
    }

    if (node.lifecycleStatus === 'ACTIVE') {
      return node; // Idempotent
    }

    let targetParentId = node.parentId;

    // If parent is also trashed or deleted, fallback to root
    if (targetParentId !== null) {
      const parent = this.fileRepo.findById(targetParentId);
      if (!parent || parent.lifecycleStatus !== 'ACTIVE') {
        targetParentId = null;
        this.fileRepo.update(id, { parentId: null });
      }
    }

    // Check sibling duplicate name at target destination
    this.assertNoSiblingConflict(node.name, targetParentId, id);

    if (node.isFolder) {
      this.fileRepo.restoreRecursive(id);
    } else {
      this.fileRepo.restore(id);
    }

    const restored = this.fileRepo.findById(id)!;
    this.eventBus?.publish('FILE_RESTORED', restored);
    return restored;
  }

  /**
   * Lists all items currently in the trash bin.
   */
  listTrash(): SmartFile[] {
    return this.fileRepo.findTrashed();
  }

  /**
   * Purges all trashed virtual records.
   */
  emptyTrash(): number {
    const count = this.fileRepo.emptyTrash();
    this.eventBus?.publish('FILE_DELETED', { count, target: 'TRASH' });
    return count;
  }

  /**
   * Permanently deletes a virtual file or folder record.
   */
  deletePermanently(id: number): boolean {
    const node = this.fileRepo.findById(id);
    if (!node) {
      return false;
    }

    if (node.isFolder) {
      const children = this.fileRepo.findByParentId(id);
      for (const child of children) {
        this.deletePermanently(child.id);
      }
    }

    const deleted = this.fileRepo.deletePermanently(id);
    if (deleted) {
      this.eventBus?.publish('FILE_DELETED', { id, name: node.name, isFolder: node.isFolder });
    }
    return deleted;
  }

  private assertNoSiblingConflict(name: string, parentId: number | null, excludeId?: number): void {
    const normParentId = this.normalizeParentId(parentId);
    const siblings = this.fileRepo.findActiveByParentId(normParentId);
    const hasConflict = siblings.some(
      (s) => s.name.toLowerCase() === name.toLowerCase() && s.id !== excludeId
    );

    if (hasConflict) {
      throw new DuplicateSiblingError(name, normParentId);
    }
  }
}
