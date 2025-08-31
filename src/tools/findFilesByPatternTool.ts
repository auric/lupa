import { z } from 'zod';
import { BaseTool } from './baseTool';
import { GitOperationsManager } from '../services/gitOperationsManager';
import { FileDiscoverer } from '../utils/fileDiscoverer';

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


export class FindFilesByPatternTool extends BaseTool {
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

      const gitRepo = this.gitOperationsManager.getRepository();
      if (!gitRepo) {
        throw new Error('Git repository not found');
      }

      // Use FileDiscoverer to find files matching the pattern
      const result = await FileDiscoverer.discoverFiles(gitRepo, {
        searchPath: searchPath || '.',
        includePattern: pattern,
        respectGitignore: true
      });

      // Handle truncated results
      if (result.truncated) {
        return [
          `Found ${result.totalFound} files (showing first ${result.files.length}):`,
          ...result.files,
          `... and ${result.totalFound - result.files.length} more files. Consider using a more specific pattern.`
        ];
      }

      return result.files.length === 0
        ? [`No files found matching pattern '${pattern}' in directory '${searchPath || '.'}'`]
        : result.files;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return [`Unable to find files matching pattern '${args.pattern}' in directory '${args.search_directory || '.'}': ${errorMessage}`];
    }
  }

}
