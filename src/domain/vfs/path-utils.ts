export class PathUtils {
  private static readonly INVALID_CHARS_REGEX = /[<>:"/\\|?*\x00-\x1F]/;
  private static readonly RESERVED_NAMES = new Set([
    'CON',
    'PRN',
    'AUX',
    'NUL',
    'COM1',
    'COM2',
    'COM3',
    'COM4',
    'COM5',
    'COM6',
    'COM7',
    'COM8',
    'COM9',
    'LPT1',
    'LPT2',
    'LPT3',
    'LPT4',
    'LPT5',
    'LPT6',
    'LPT7',
    'LPT8',
    'LPT9',
  ]);

  /**
   * Sanitizes and validates a virtual file or folder name.
   * Throws an Error if the name contains path traversal attempts or invalid characters.
   */
  static validateNodeName(name: string): string {
    const trimmed = name.trim();

    if (!trimmed || trimmed.length === 0) {
      throw new Error('Node name cannot be empty');
    }

    if (trimmed.length > 255) {
      throw new Error('Node name exceeds maximum length of 255 characters');
    }

    if (trimmed === '.' || trimmed === '..') {
      throw new Error('Node name cannot be "." or ".."');
    }

    if (this.INVALID_CHARS_REGEX.test(trimmed)) {
      throw new Error(`Node name "${trimmed}" contains invalid or forbidden characters`);
    }

    const baseUpper = trimmed.split('.')[0].toUpperCase();
    if (this.RESERVED_NAMES.has(baseUpper)) {
      throw new Error(`Node name "${trimmed}" is a reserved system filename`);
    }

    return trimmed;
  }

  /**
   * Normalizes a virtual path string to standard `/segment/subsegment` form.
   */
  static normalizeVirtualPath(rawPath: string): string {
    if (!rawPath || rawPath === '' || rawPath === '/') {
      return '/';
    }

    const segments = rawPath
      .replace(/\\/g, '/')
      .split('/')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    if (segments.length === 0) {
      return '/';
    }

    for (const segment of segments) {
      if (segment === '..') {
        throw new Error('Path traversal ".." is forbidden in virtual paths');
      }
      if (segment === '.') {
        continue;
      }
    }

    return '/' + segments.join('/');
  }

  /**
   * Splits a virtual path into array of segments.
   */
  static splitPath(virtualPath: string): string[] {
    const normalized = this.normalizeVirtualPath(virtualPath);
    if (normalized === '/') {
      return [];
    }
    return normalized.substring(1).split('/');
  }
}
