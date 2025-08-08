import * as path from 'path';

/**
 * Static utility class for file type detection and code file operations.
 * Used by symbol tools to identify files that likely contain code symbols.
 */
export class CodeFileUtils {
  /**
   * List of file extensions that typically contain code symbols
   */
  private static readonly CODE_EXTENSIONS = [
    'ts', 'js', 'tsx', 'jsx',
    'py', 'java', 'cs',
    'cpp', 'c', 'h', 'hpp',
    'go', 'rs', 'php', 'rb', 'swift',
    'kt', 'scala', 'clj', 'hs',
    'vue', 'svelte'
  ];

  /**
   * Check if a file is likely to contain code symbols based on its extension
   * @param fileName - Name of the file including extension
   * @returns True if the file is likely to contain code symbols
   */
  static isCodeFile(fileName: string): boolean {
    const ext = this.getFileExtension(fileName);
    return this.CODE_EXTENSIONS.includes(ext);
  }

  /**
   * Extract the file extension from a filename in normalized lowercase form
   * @param fileName - Name of the file including extension
   * @returns The lowercase file extension without the dot, or empty string if no extension
   */
  static getFileExtension(fileName: string): string {
    return path.extname(fileName).toLowerCase().slice(1);
  }

  /**
   * Get the list of supported code file extensions
   * @returns Array of supported file extensions (without dots)
   */
  static getSupportedExtensions(): readonly string[] {
    return this.CODE_EXTENSIONS;
  }
}