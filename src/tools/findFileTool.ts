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
 * Tool that finds files matching glob patterns within a directory.
 * Automatically respects .gitignore rules and prevents directory traversal attacks.
 * Returns relative paths from project root.
 *
 * Supported glob patterns:
 * - * matches any number of characters (except path separators)
 * - ? matches exactly one character (except path separators)
 * - ** matches any number of directories recursively
 * - [abc] matches any character in the brackets
 * - {a,b,c} matches any of the patterns in the braces
 */

// Examples for LLM usage:
// - "*.js" - all JavaScript files in search directory
// - "**/*.ts" - all TypeScript files recursively
// - "src/**/*.{js,ts}" - all JS/TS files in src directory recursively
// - "test?.js" - test1.js, testA.js, etc.
// - "README*" - README files with any extension

const MAX_RESULTS = 1000; // Prevent excessive memory usage
const SEARCH_TIMEOUT = 30000; // 30 second timeout for expensive searches

export class FindFileTool extends BaseTool {
  name = 'find_files_by_pattern';
  description = 'Find files matching glob patterns within a directory. Supports wildcards (*.js), recursive search (**/*.ts), multiple extensions (*.{js,ts}). Automatically respects .gitignore rules. Returns relative paths from project root.';

  schema = z.object({
    pattern: z.string().min(1, 'Search pattern cannot be empty').describe('Glob pattern to match files: "*.js" (JS files), "**/*.test.ts" (test files recursively), "src/**/*.{js,ts}" (JS/TS in src directory), "README*" (README files)'),
    search_directory: z.string().default('.').optional().describe('Directory to search within, relative to project root. Use "." for entire project, "src" for src folder, "tests" for test directory (default: ".")')
  });

  constructor(private readonly gitOperationsManager: GitOperationsManager) {
    super();
  }

  async execute(args: z.infer<typeof this.schema>): Promise<string[]> {
    try {
      const { pattern, search_directory: searchPath } = args;

      // Sanitize the search directory to prevent directory traversal attacks
      const sanitizedPath = PathSanitizer.sanitizePath(searchPath || '.');

      // Find files matching the pattern with timeout protection
      const result = await Promise.race([
        this.findFiles(pattern, sanitizedPath),
        new Promise<string[]>((_, reject) =>
          setTimeout(() => reject(new Error('Search timeout - pattern too expensive')), SEARCH_TIMEOUT)
        )
      ]);

      // Limit results to prevent excessive memory usage
      if (result.length > MAX_RESULTS) {
        return [
          `Found ${result.length} files (showing first ${MAX_RESULTS}):`,
          ...result.slice(0, MAX_RESULTS),
          `... and ${result.length - MAX_RESULTS} more files. Consider using a more specific pattern.`
        ];
      }

      return result.length === 0
        ? [`No files found matching pattern '${pattern}' in directory '${searchPath || '.'}'`]
        : result;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return [`Unable to find files matching pattern '${args.pattern}' in directory '${args.search_directory || '.'}': ${errorMessage}`];
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
