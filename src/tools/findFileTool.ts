import { z } from 'zod';
import * as path from 'path';
import { fdir } from 'fdir';
import picomatch from 'picomatch';
import ignore from 'ignore';
import { BaseTool } from './baseTool';
import { GitOperationsManager } from '../services/gitOperationsManager';
import { PathSanitizer } from '../utils/pathSanitizer';
import { readGitignore } from '../utils/gitUtils';

/**
 * Tool that finds files matching a given name or glob pattern.
 * Respects .gitignore and other ignore files, prevents directory traversal attacks.
 *
 * Supported glob patterns:
 * - * matches any number of characters (except path separators)
 * - ? matches exactly one character (except path separators)
 * - ** matches any number of directories
 * - [abc] matches any character in the brackets
 * - {a,b,c} matches any of the patterns in the braces
 */

// Examples:
// - "*.js" - all JavaScript files in the current directory
// - "**/*.ts" - all TypeScript files recursively
// - "src/**/*.{js,ts}" - all JS/TS files in src directory recursively
// - "test?.js" - test1.js, testA.js, etc.

export class FindFileTool extends BaseTool {
  name = 'find_file';
  description = 'Find files by name or glob pattern within a specified path. Supports glob patterns like *.js, **/*.ts, src/**/*.{js,ts}. Respects .gitignore files.';

  schema = z.object({
    fileName: z.string().min(1, 'File name cannot be empty').describe('The filename or glob pattern to search for (e.g., "*.js", "**/*.ts", "src/**/*.{js,ts}")'),
    path: z.string().default('.').optional().describe('Optional relative path to search within (default: project root)')
  });

  constructor(private readonly gitOperationsManager: GitOperationsManager) {
    super();
  }

  async execute(args: z.infer<typeof this.schema>): Promise<string[]> {
    try {
      const { fileName, path: searchPath } = args;

      // Sanitize the relative path to prevent directory traversal attacks
      const sanitizedPath = PathSanitizer.sanitizePath(searchPath || '.');

      // Find files matching the pattern
      const result = await this.findFiles(fileName, sanitizedPath);

      return result;

    } catch (error) {
      return [`Error finding files: ${error instanceof Error ? error.message : String(error)}`];
    }
  }

  /**
   * Finds files matching the given glob pattern within the specified path
   */
  private async findFiles(pattern: string, searchPath: string): Promise<string[]> {
    try {
      const gitRootDirectory = this.gitOperationsManager.getRepository()?.rootUri.fsPath || '';
      if (!gitRootDirectory) {
        throw new Error('Git repository not found');
      }

      const targetPath = path.join(gitRootDirectory, searchPath);

      // Read .gitignore patterns
      const gitignorePatterns = await readGitignore(this.gitOperationsManager.getRepository());
      const ig = ignore().add(gitignorePatterns);

      // Use fdir with glob pattern matching and gitignore filtering
      const files = await new fdir()
        .withGlobFunction(picomatch)
        .glob(pattern)
        .withRelativePaths() // Return paths relative to the search directory
        .exclude((dirName, dirPath) => {
          // Check if directory should be ignored based on .gitignore
          const relativePath = path.relative(gitRootDirectory, dirPath);
          return ig.checkIgnore(relativePath).ignored || ig.checkIgnore(dirName).ignored;
        })
        .filter((filePath, isDirectory) => {
          if (isDirectory) return true; // Don't filter directories at this level

          // Check if file should be ignored based on .gitignore
          const fullPath = path.join(targetPath, filePath);
          const relativePath = path.relative(gitRootDirectory, fullPath);
          return !ig.checkIgnore(relativePath).ignored;
        })
        .crawl(targetPath)
        .withPromise();

      // Convert to proper relative paths from project root
      const results = files.map(file => {
        const fullPath = path.join(targetPath, file);
        const relativePath = path.relative(gitRootDirectory, fullPath);
        return relativePath.replace(/\\/g, '/'); // Normalize to forward slashes
      });

      return results.sort();
    } catch (error) {
      throw new Error(`Failed to find files matching '${pattern}' in '${searchPath}': ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
