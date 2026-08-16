import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabaseConnection, DatabaseConnection } from '../../src/persistence/db.js';
import { runMigrations } from '../../src/persistence/migrate.js';
import { FileRepository } from '../../src/persistence/repositories/file.repository.js';
import { VirtualFilesystemService, DuplicateSiblingError, InvalidParentError } from '../../src/domain/vfs/vfs.service.js';
import { PathUtils } from '../../src/domain/vfs/path-utils.js';
import { HierarchyCycleError, EntityNotFoundError } from '../../src/domain/errors.js';

describe('Virtual Filesystem (VFS) Suite', () => {
  let conn: DatabaseConnection;
  let fileRepo: FileRepository;
  let vfs: VirtualFilesystemService;

  beforeEach(() => {
    conn = createDatabaseConnection(':memory:');
    runMigrations(conn);
    fileRepo = new FileRepository(conn.db);
    vfs = new VirtualFilesystemService(fileRepo);
  });

  afterEach(() => {
    conn.close();
  });

  describe('PathUtils Validation & Sanitization', () => {
    it('validates safe names and normalizes paths', () => {
      expect(PathUtils.validateNodeName('Documents')).toBe('Documents');
      expect(PathUtils.validateNodeName('my_archive.tar.gz')).toBe('my_archive.tar.gz');
      expect(PathUtils.validateNodeName('Report (2026).pdf')).toBe('Report (2026).pdf');

      expect(PathUtils.normalizeVirtualPath('/Projects/Backend/')).toBe('/Projects/Backend');
      expect(PathUtils.normalizeVirtualPath('Documents/Notes')).toBe('/Documents/Notes');
      expect(PathUtils.normalizeVirtualPath('')).toBe('/');
      expect(PathUtils.normalizeVirtualPath('/')).toBe('/');
    });

    it('rejects path traversal, reserved names and invalid characters', () => {
      expect(() => PathUtils.validateNodeName('')).toThrow(/empty/);
      expect(() => PathUtils.validateNodeName('..')).toThrow();
      expect(() => PathUtils.validateNodeName('.')).toThrow();
      expect(() => PathUtils.validateNodeName('folder/name')).toThrow(/invalid/);
      expect(() => PathUtils.validateNodeName('folder\\name')).toThrow(/invalid/);
      expect(() => PathUtils.validateNodeName('CON')).toThrow(/reserved/);
      expect(() => PathUtils.validateNodeName('NUL.txt')).toThrow(/reserved/);
      expect(() => PathUtils.validateNodeName('bad*name?')).toThrow(/invalid/);

      expect(() => PathUtils.normalizeVirtualPath('/Projects/../Secret')).toThrow(/forbidden/);
    });
  });

  describe('Folder Creation & Duplicate Prevention', () => {
    it('creates root and nested folders successfully', () => {
      const rootFolder = vfs.createFolder(null, 'Projects');
      expect(rootFolder.id).toBeDefined();
      expect(rootFolder.name).toBe('Projects');
      expect(rootFolder.parentId).toBeNull();
      expect(rootFolder.isFolder).toBe(true);

      const subFolder = vfs.createFolder(rootFolder.id, 'Backend');
      expect(subFolder.parentId).toBe(rootFolder.id);
      expect(subFolder.name).toBe('Backend');

      const children = vfs.listChildren(rootFolder.id);
      expect(children).toHaveLength(1);
      expect(children[0].name).toBe('Backend');
    });

    it('prevents duplicate sibling folder names', () => {
      vfs.createFolder(null, 'Photos');
      expect(() => {
        vfs.createFolder(null, 'Photos');
      }).toThrow(DuplicateSiblingError);

      // Case-insensitive duplicate check
      expect(() => {
        vfs.createFolder(null, 'photos');
      }).toThrow(DuplicateSiblingError);
    });

    it('rejects creating folder under non-folder or nonexistent parent', () => {
      const now = Date.now();
      const file = fileRepo.insert({
        name: 'test.txt',
        parentId: null,
        isFolder: false,
        mimeType: 'text/plain',
        size: 100,
        lifecycleStatus: 'ACTIVE',
        createdAt: now,
        updatedAt: now,
      });

      expect(() => vfs.createFolder(file.id, 'SubDir')).toThrow(InvalidParentError);
      expect(() => vfs.createFolder(99999, 'SubDir')).toThrow(EntityNotFoundError);
    });
  });

  describe('Node Renaming', () => {
    it('renames folders and files safely', () => {
      const folder = vfs.createFolder(null, 'OldName');
      const renamed = vfs.renameNode(folder.id, 'NewName');
      expect(renamed.name).toBe('NewName');

      const lookup = vfs.getNodeById(folder.id);
      expect(lookup?.name).toBe('NewName');
    });

    it('rejects renaming to existing sibling name', () => {
      const f1 = vfs.createFolder(null, 'Folder1');
      vfs.createFolder(null, 'Folder2');

      expect(() => {
        vfs.renameNode(f1.id, 'Folder2');
      }).toThrow(DuplicateSiblingError);
    });
  });

  describe('Virtual Path Resolution & Tree Structure', () => {
    it('resolves nodes by virtual path and computes absolute paths', () => {
      const f1 = vfs.createFolder(null, 'Workspace');
      const f2 = vfs.createFolder(f1.id, 'Java');
      const f3 = vfs.createFolder(f2.id, 'SmartDrive');

      const now = Date.now();
      const file = fileRepo.insert({
        name: 'README.md',
        parentId: f3.id,
        isFolder: false,
        mimeType: 'text/markdown',
        size: 2048,
        lifecycleStatus: 'ACTIVE',
        createdAt: now,
        updatedAt: now,
      });

      expect(vfs.getAbsolutePath(f1.id)).toBe('/Workspace');
      expect(vfs.getAbsolutePath(f3.id)).toBe('/Workspace/Java/SmartDrive');
      expect(vfs.getAbsolutePath(file.id)).toBe('/Workspace/Java/SmartDrive/README.md');

      const resolved = vfs.getNodeByPath('/Workspace/Java/SmartDrive/README.md');
      expect(resolved).not.toBeNull();
      expect(resolved?.id).toBe(file.id);

      const nonExistent = vfs.getNodeByPath('/Workspace/Java/NonExistent.txt');
      expect(nonExistent).toBeNull();
    });

    it('builds full virtual hierarchy tree', () => {
      const root1 = vfs.createFolder(null, 'Docs');
      const root2 = vfs.createFolder(null, 'Media');
      vfs.createFolder(root1.id, 'Invoices');

      const tree = vfs.getTree();
      expect(tree.virtualPath).toBe('/');
      expect(tree.children).toHaveLength(2);
      expect(tree.children?.map((c) => c.name)).toContain('Docs');
      expect(tree.children?.map((c) => c.name)).toContain('Media');

      const docsNode = tree.children?.find((c) => c.name === 'Docs');
      expect(docsNode?.children).toHaveLength(1);
      expect(docsNode?.children?.[0].name).toBe('Invoices');
      expect(docsNode?.children?.[0].virtualPath).toBe('/Docs/Invoices');
    });
  });

  describe('Cycle-Safe Virtual Move Operations', () => {
    it('moves nodes across branches cleanly', () => {
      const branchA = vfs.createFolder(null, 'BranchA');
      const branchB = vfs.createFolder(null, 'BranchB');

      const now = Date.now();
      const file = fileRepo.insert({
        name: 'app.zip',
        parentId: branchA.id,
        isFolder: false,
        mimeType: 'application/zip',
        size: 1000,
        lifecycleStatus: 'ACTIVE',
        createdAt: now,
        updatedAt: now,
      });

      expect(vfs.getAbsolutePath(file.id)).toBe('/BranchA/app.zip');

      const moved = vfs.moveNode(file.id, branchB.id);
      expect(moved.parentId).toBe(branchB.id);
      expect(vfs.getAbsolutePath(file.id)).toBe('/BranchB/app.zip');
    });

    it('rejects moving folder into itself (Self-Parenting)', () => {
      const folder = vfs.createFolder(null, 'Projects');
      expect(() => {
        vfs.moveNode(folder.id, folder.id);
      }).toThrow(HierarchyCycleError);
    });

    it('rejects moving folder into direct child', () => {
      const parent = vfs.createFolder(null, 'Parent');
      const child = vfs.createFolder(parent.id, 'Child');

      expect(() => {
        vfs.moveNode(parent.id, child.id);
      }).toThrow(HierarchyCycleError);
    });

    it('rejects moving folder into deep descendant (A -> B -> C -> D, move A into D)', () => {
      const fA = vfs.createFolder(null, 'A');
      const fB = vfs.createFolder(fA.id, 'B');
      const fC = vfs.createFolder(fB.id, 'C');
      const fD = vfs.createFolder(fC.id, 'D');

      expect(() => {
        vfs.moveNode(fA.id, fD.id);
      }).toThrow(HierarchyCycleError);

      expect(() => {
        vfs.moveNode(fB.id, fD.id);
      }).toThrow(HierarchyCycleError);
    });
  });

  describe('Trash, Restore & Permanent Deletion', () => {
    it('trashes and restores nodes with parent fallback', () => {
      const folder = vfs.createFolder(null, 'Personal');
      const now = Date.now();
      const file = fileRepo.insert({
        name: 'diary.txt',
        parentId: folder.id,
        isFolder: false,
        mimeType: 'text/plain',
        size: 100,
        lifecycleStatus: 'ACTIVE',
        createdAt: now,
        updatedAt: now,
      });

      vfs.trashNode(file.id);
      expect(vfs.getNodeById(file.id)?.lifecycleStatus).toBe('TRASHED');

      // Trashed items excluded from regular list
      expect(vfs.listChildren(folder.id)).toHaveLength(0);
      expect(vfs.listChildren(folder.id, true)).toHaveLength(1);

      vfs.restoreNode(file.id);
      expect(vfs.getNodeById(file.id)?.lifecycleStatus).toBe('ACTIVE');
      expect(vfs.listChildren(folder.id)).toHaveLength(1);
    });

    it('permanently deletes nodes and cascading folder contents', () => {
      const parent = vfs.createFolder(null, 'TempFolder');
      const child = vfs.createFolder(parent.id, 'TempChild');

      expect(vfs.deletePermanently(parent.id)).toBe(true);
      expect(vfs.getNodeById(parent.id)).toBeNull();
      expect(vfs.getNodeById(child.id)).toBeNull();
    });
  });
});
