import * as path from 'path';

/**
 * Utility class for sanitizing and validating paths to prevent security vulnerabilities
 * such as directory traversal attacks.
 */
export class PathSanitizer {
  /**
   * Sanitizes the relative path to prevent directory traversal attacks
   * Handles Windows absolute paths and UNC paths by rejecting them
   * @param relativePath The path to sanitize
   * @returns The sanitized path
   * @throws Error if the path is invalid or contains traversal attempts
   */
  static sanitizePath(relativePath: string): string {
    const trimmedPath = relativePath.trim();

    // Check for Windows absolute paths and UNC paths (these should be rejected as they're not relative)
    if (this.isAbsolutePath(trimmedPath)) {
      throw new Error('Invalid path: Absolute paths are not allowed, only relative paths');
    }

    // Normalize path separators to forward slashes for consistent handling
    const normalizedPath = path.posix.normalize(trimmedPath.replaceAll(path.sep, path.posix.sep));

    // Check for directory traversal attempts
    if (normalizedPath.startsWith('..') || normalizedPath.startsWith('/')) {
      throw new Error('Invalid path: Directory traversal detected');
    }

    // Check if normalized path contains directory traversal sequences
    if (normalizedPath.includes('../')) {
      throw new Error('Invalid path: Directory traversal detected');
    }

    return normalizedPath === '' ? '.' : normalizedPath;
  }

  /**
   * Checks if a path is an absolute path (Windows or Unix style)
   * @param inputPath The path to check
   * @returns True if the path is absolute, false otherwise
   */
  static isAbsolutePath(inputPath: string): boolean {
    // Windows drive letter (C:, D:, etc.)
    if (/^[A-Za-z]:/.test(inputPath)) {
      return true;
    }

    // UNC paths (\\server\share or \\?\UNC\server\share)
    if (inputPath.startsWith('\\\\')) {
      return true;
    }

    // Extended-length path prefix (\\?\C:\ or \\?\UNC\)
    if (inputPath.startsWith('\\\\?\\')) {
      return true;
    }

    // Device path prefix (\\.\)
    if (inputPath.startsWith('\\\\.\\')) {
      return true;
    }

    // Unix absolute path
    if (inputPath.startsWith('/')) {
      return true;
    }

    return false;
  }
}
