import { z } from 'zod';
import * as path from 'path';
import * as vscode from 'vscode';
import ignore from 'ignore';
import { BaseTool } from './baseTool';
import { GitOperationsManager } from '../services/gitOperationsManager';
import { PathSanitizer } from '../utils/pathSanitizer';
import { readGitignore } from '../lib/pathUtils';
import { SearchResultFormatter } from './searchResultFormatter';

/**
 * Tool that searches for regex patterns in the codebase.
 * Respects .gitignore files and supports file filtering with glob patterns.
 */
export class SearchForPatternTool extends BaseTool {
  name = 'search_for_pattern';
  description = 'Search for a regex pattern in the codebase, with optional path filtering and glob pattern support. Returns structured XML with matches, file paths, and line numbers.';

  private readonly formatter = new SearchResultFormatter();

  schema = z.object({
    pattern: z.string().min(1, 'Pattern cannot be empty').describe('The regex pattern to search for in file contents'),
    include: z.string().optional().describe('Optional glob pattern to filter files (e.g., "*.ts", "src/**/*.js")'),
    path: z.string().optional().describe('Optional relative path to search within (e.g., "src", "src/components")')
  });

  constructor(private readonly gitOperationsManager: GitOperationsManager) {
    super();
  }

  async execute(args: z.infer<typeof this.schema>): Promise<string[]> {
    const { pattern, include, path: searchPath } = args;
    
    try {
      // Sanitize the search path if provided
      const sanitizedPath = searchPath ? PathSanitizer.sanitizePath(searchPath) : '.';

      // Search for pattern in files
      const matches = await this.searchForPattern(pattern, include, sanitizedPath);

      // Format the output using structured XML formatter
      return this.formatter.formatResults(matches);

    } catch (error) {
      return [this.formatter.formatError(error)];
    }
  }

  /**
   * Searches for the regex pattern in files, respecting gitignore and glob patterns
   */
  private async searchForPattern(
    pattern: string,
    include: string | undefined,
    searchPath: string = '.'
  ): Promise<Array<{ filePath: string; lineNumber: number; line: string }>> {
    try {
      // Create regex from pattern with dotall flag for multiline matching
      const regex = new RegExp(pattern, 'gims');

      const ig = ignore().add(await readGitignore(this.gitOperationsManager.getRepository()));
      const gitRootDirectory = this.gitOperationsManager.getRepository()?.rootUri.fsPath || '';

      // Get all files to search
      const filesToSearch = await this.getFilesToSearch(gitRootDirectory, searchPath, include, ig);

      const matches: Array<{ filePath: string; lineNumber: number; line: string }> = [];

      // Search each file for the pattern
      for (const filePath of filesToSearch) {
        try {
          const fileUri = vscode.Uri.file(path.posix.join(gitRootDirectory, filePath));
          const fileContent = await vscode.workspace.fs.readFile(fileUri);
          const text = fileContent.toString();

          // Split into lines for line-by-line matching
          const lines = text.split('\n');

          for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
            const line = lines[lineIndex];

            // Reset regex lastIndex to avoid global regex state issues
            regex.lastIndex = 0;

            if (regex.test(line)) {
              matches.push({
                filePath,
                lineNumber: lineIndex + 1, // 1-based line numbers
                line: line.trimEnd() // Remove trailing whitespace
              });
            }
          }
        } catch (error) {
          // Skip files that can't be read (binary files, permission issues, etc.)
          continue;
        }
      }

      return matches;
    } catch (error) {
      throw new Error(`Pattern search failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get list of files to search, applying glob patterns and gitignore rules
   */
  private async getFilesToSearch(
    gitRootDirectory: string,
    searchPath: string,
    include: string | undefined,
    ig: ReturnType<typeof ignore>
  ): Promise<string[]> {
    const files: string[] = [];

    // Create glob pattern matcher if include pattern is provided
    let globPattern: RegExp | undefined;
    if (include) {
      // Convert glob pattern to regex (basic implementation)
      const globRegexSource = include
        .replace(/\./g, '\\.')  // Escape dots
        .replace(/\*/g, '.*')   // Convert * to .*
        .replace(/\?/g, '.')    // Convert ? to .
        .replace(/\\\.\*/g, '\\*'); // Fix escaped dots followed by *

      globPattern = new RegExp(`^${globRegexSource}$`, 'i');
    }

    await this.scanDirectory(gitRootDirectory, searchPath, files, ig, globPattern);

    return files;
  }

  /**
   * Recursively scan directory for files
   */
  private async scanDirectory(
    gitRootDirectory: string,
    currentPath: string,
    files: string[],
    ig: ReturnType<typeof ignore>,
    globPattern: RegExp | undefined
  ): Promise<void> {
    try {
      const targetPath = path.posix.join(gitRootDirectory, currentPath);
      const targetUri = vscode.Uri.file(targetPath);

      const entries = await vscode.workspace.fs.readDirectory(targetUri);

      for (const [name, type] of entries) {
        const fullPath = currentPath === '.' ? name : path.posix.join(currentPath, name);

        // Skip if ignored by gitignore
        if (ig?.checkIgnore(fullPath).ignored) {
          continue;
        }

        if (type === vscode.FileType.Directory) {
          // Recursively scan subdirectories
          await this.scanDirectory(gitRootDirectory, fullPath, files, ig, globPattern);
        } else if (type === vscode.FileType.File) {
          // Check if file matches glob pattern (if provided)
          if (!globPattern || globPattern.test(fullPath)) {
            files.push(fullPath);
          }
        }
      }
    } catch (error) {
      // Skip directories that can't be read
      return;
    }
  }

}
