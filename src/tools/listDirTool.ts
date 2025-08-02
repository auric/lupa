import { z } from 'zod';
import * as path from 'path';
import * as vscode from 'vscode';
import ignore from 'ignore'
import { BaseTool } from './baseTool';
import { GitOperationsManager } from '../services/gitOperationsManager';
import { PathSanitizer } from '../utils/pathSanitizer';
import { readGitignore } from '../utils/gitUtils';

/**
 * Tool that lists the contents of a directory, with optional recursion.
 * Respects .gitignore and other ignore files, prevents directory traversal attacks.
 */
export class ListDirTool extends BaseTool {
  name = 'list_directory';
  description = 'List files and directories within a specified path, with optional recursion. Respects .gitignore files.';

  schema = z.object({
    relativePath: z.string().min(1, 'Relative path cannot be empty').describe('The relative path to the directory to list (e.g., "src", "src/components", "." for root)'),
    recursive: z.boolean().describe('Whether to scan subdirectories recursively')
  });

  constructor(private readonly gitOperationsManager: GitOperationsManager) {
    super();
  };

  async execute(args: z.infer<typeof this.schema>): Promise<string[]> {
    try {
      const { relativePath, recursive } = args;

      // Sanitize the relative path to prevent directory traversal attacks
      const sanitizedPath = PathSanitizer.sanitizePath(relativePath);

      // List directory contents with ignore pattern support
      const result = await this.callListDir(sanitizedPath, recursive);

      // Format the output as a simple list of strings
      return this.formatOutput(result);

    } catch (error) {
      return [`Error listing directory: ${error instanceof Error ? error.message : String(error)}`];
    }
  }


  /**
   * Lists directory contents respecting .gitignore and other ignore files
   */
  private async callListDir(relativePath: string, recursive: boolean): Promise<{ dirs: string[], files: string[] }> {
    try {
      const ig = ignore().add(await readGitignore(this.gitOperationsManager.getRepository()));

      const gitRootDirectory = this.gitOperationsManager.getRepository()?.rootUri.fsPath || '';
      const targetPath = path.join(gitRootDirectory, relativePath);
      const targetUri = vscode.Uri.file(targetPath);

      const entries = await vscode.workspace.fs.readDirectory(targetUri);
      const dirs: string[] = [];
      const files: string[] = [];

      for (const [name, type] of entries) {
        if (ig.checkIgnore(name).ignored) {
          continue;
        }

        const fullPath = relativePath === '.' ? name : path.posix.join(relativePath, name);

        if (type === vscode.FileType.Directory) {
          dirs.push(fullPath);

          // If recursive, scan subdirectories
          if (recursive) {
            try {
              const subResult = await this.callListDir(fullPath, recursive);
              dirs.push(...subResult.dirs);
              files.push(...subResult.files);
            } catch {
              // Skip directories that can't be read
            }
          }
        } else if (type === vscode.FileType.File) {
          files.push(fullPath);
        }
      }

      return { dirs, files };
    } catch (error) {
      throw new Error(`Failed to read directory '${relativePath}': ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Formats the output as a simple list of strings
   */
  private formatOutput(result: { dirs: string[], files: string[] }): string[] {
    const output: string[] = [];

    // Add directories first, sorted
    const sortedDirs = result.dirs.sort();
    for (const dir of sortedDirs) {
      output.push(`${dir}/`);
    }

    // Add files, sorted
    const sortedFiles = result.files.sort();
    for (const file of sortedFiles) {
      output.push(file);
    }

    return output;
  }
}
