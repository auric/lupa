import { z } from 'zod';
import * as path from 'path';
import * as vscode from 'vscode';
import ignore from 'ignore';
import { BaseTool } from './baseTool';
import { SymbolRangeExpander } from './symbolRangeExpander';
import { DefinitionFormatter } from './definitionFormatter';
import { GitOperationsManager } from '../services/gitOperationsManager';
import { PathSanitizer } from '../utils/pathSanitizer';
import { readGitignore } from '../utils/gitUtils';

/**
 * Tool that finds the definition of a code symbol using VS Code's definition provider.
 * Uses vscode.executeDefinitionProvider to locate symbol definitions.
 */
export class FindSymbolTool extends BaseTool {
  name = 'find_symbol';
  description = "Find the definition of a code symbol by name using VS Code's definition provider";

  private readonly rangeExpander = new SymbolRangeExpander();
  private readonly formatter = new DefinitionFormatter();

  constructor(private readonly gitOperationsManager: GitOperationsManager) {
    super();
  }

  schema = z.object({
    symbolName: z.string().min(1, 'Symbol name cannot be empty').describe('The name of the symbol to find the definition for'),
    searchPath: z.string().optional().describe("Optional relative path to search within (e.g., 'src/components/Button.tsx')"),
    shouldIncludeFullBody: z.boolean().default(true).optional().describe('Whether to include the full symbol body (default: true). Set to false for just location info.'),
  });

  async execute(args: z.infer<typeof this.schema>): Promise<string[]> {
    try {
      const { symbolName, searchPath, shouldIncludeFullBody } = args;

      // Sanitize input to prevent potential injection attacks
      const sanitizedSymbolName = symbolName.trim();
      if (!sanitizedSymbolName) {
        return ['Error: Symbol name cannot be empty'];
      }

      // Get git repository root
      const gitRootDirectory = this.gitOperationsManager.getRepository()?.rootUri.fsPath;
      if (!gitRootDirectory) {
        return ['Error: Git repository not found'];
      }

      // Sanitize the search path to prevent directory traversal attacks
      const sanitizedPath = searchPath ? PathSanitizer.sanitizePath(searchPath.trim()) : '.';

      // Get all files to search through
      const filesToSearch = await this.getAllFiles(gitRootDirectory, sanitizedPath);

      const definitions: vscode.Location[] = [];

      // Search through all repository files for the symbol
      for (const filePath of filesToSearch) {
        const fullPath = path.join(gitRootDirectory, filePath);
        const fileUri = vscode.Uri.file(fullPath);

        try {
          const document = await vscode.workspace.openTextDocument(fileUri);
          const text = document.getText();
          const lines = text.split('\n');

          for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
            const line = lines[lineIndex];
            const symbolIndex = line.indexOf(sanitizedSymbolName);

            if (symbolIndex !== -1) {
              const position = new vscode.Position(lineIndex, symbolIndex);

              try {
                // Use VS Code's definition provider to find the symbol definition
                let foundDefinitions = await vscode.commands.executeCommand<vscode.Location[]>(
                  'vscode.executeDefinitionProvider',
                  document.uri,
                  position
                );

                if (foundDefinitions && foundDefinitions.length > 0) {
                  foundDefinitions = foundDefinitions.filter(def => {
                    // Filter out definitions that are not in the same file
                    return def.uri.toString() === document.uri.toString();
                  });
                  definitions.push(...foundDefinitions);
                }
              } catch (error) {
                // Continue searching even if one position fails
                continue;
              }
            }
          }
        } catch (error) {
          // Skip files that can't be opened
          continue;
        }
      }

      // Remove duplicates based on URI and range
      const uniqueDefinitions = definitions.filter((def, index, arr) => {
        return arr.findIndex(d =>
          d.uri.toString() === def.uri.toString() &&
          d.range.start.line === def.range.start.line &&
          d.range.start.character === def.range.start.character
        ) === index;
      });

      if (uniqueDefinitions.length === 0) {
        return [this.formatter.formatNotFoundMessage(sanitizedSymbolName)];
      }

      // Extract and format the definition text from each location
      const formattedDefinitions: string[] = [];

      for (const definition of uniqueDefinitions) {
        try {
          const document = await vscode.workspace.openTextDocument(definition.uri);
          const range = definition.range;
          const filePath = vscode.workspace.asRelativePath(definition.uri);

          let symbolBody: string | undefined;
          if (shouldIncludeFullBody) {
            // Get the full symbol body by finding the complete structure (function, class, etc.)
            const fullSymbolRange = await this.rangeExpander.getFullSymbolRange(document, range);
            symbolBody = document.getText(fullSymbolRange);
          }

          const formattedDefinition = this.formatter.formatDefinition(
            filePath,
            sanitizedSymbolName,
            range,
            symbolBody,
            shouldIncludeFullBody
          );

          formattedDefinitions.push(formattedDefinition);
        } catch (error) {
          const filePath = vscode.workspace.asRelativePath(definition.uri);
          const errorDefinition = this.formatter.formatErrorDefinition(
            filePath,
            sanitizedSymbolName,
            definition.range,
            error
          );

          formattedDefinitions.push(errorDefinition);
        }
      }

      return formattedDefinitions;

    } catch (error) {
      return [`Error finding symbol definition: ${error instanceof Error ? error.message : String(error)}`];
    }
  }

  /**
   * Recursively get all code files in the repository, respecting .gitignore
   */
  private async getAllFiles(gitRootDirectory: string, searchPath: string): Promise<string[]> {
    const files: string[] = [];

    // Read .gitignore patterns
    const repository = this.gitOperationsManager.getRepository();
    const gitignoreContent = await readGitignore(repository);
    const ig = ignore().add(gitignoreContent);

    const targetPath = path.join(gitRootDirectory, searchPath);

    try {
      const targetUri = vscode.Uri.file(targetPath);
      const stat = await vscode.workspace.fs.stat(targetUri);

      if (stat.type === vscode.FileType.File) {
        // Single file
        return [searchPath === '.' ? path.basename(targetPath) : searchPath];
      } else if (stat.type === vscode.FileType.Directory) {
        // Directory - recursively get all code files
        return await this.getFilesFromDirectory(targetPath, searchPath, ig);
      }
    } catch (error) {
      // Path doesn't exist or can't be accessed
      return [];
    }

    return files;
  }

  /**
   * Recursively get all code files from a directory, respecting .gitignore
   */
  private async getFilesFromDirectory(targetPath: string, relativePath: string, ig: ReturnType<typeof ignore>, depth: number = 0): Promise<string[]> {
    const files: string[] = [];

    // Prevent infinite recursion
    if (depth > 10) {
      return files;
    }

    try {
      const targetUri = vscode.Uri.file(targetPath);
      const entries = await vscode.workspace.fs.readDirectory(targetUri);

      for (const [name, type] of entries) {
        // Check if this entry should be ignored
        if (ig.checkIgnore(name).ignored) {
          continue;
        }

        const fullPath = relativePath === '.' ? name : path.posix.join(relativePath, name);

        if (type === vscode.FileType.File) {
          // Only include files that are likely to have symbols (code files)
          if (this.isCodeFile(name)) {
            files.push(fullPath);
          }
        } else if (type === vscode.FileType.Directory) {
          // Recursively process subdirectories
          const subPath = path.join(targetPath, name);
          const subFiles = await this.getFilesFromDirectory(subPath, fullPath, ig, depth + 1);
          files.push(...subFiles);
        }
      }
    } catch (error) {
      // Skip directories that can't be read
    }

    return files;
  }

  /**
   * Check if a file is likely to contain code symbols
   */
  private isCodeFile(fileName: string): boolean {
    const codeExtensions = [
      'ts', 'js', 'tsx', 'jsx',
      'py', 'java', 'cs',
      'cpp', 'c', 'h', 'hpp',
      'go', 'rs', 'php', 'rb', 'swift',
      'kt', 'scala', 'clj', 'hs',
      'vue', 'svelte'
    ];

    const ext = path.extname(fileName).toLowerCase().slice(1);
    return codeExtensions.includes(ext);
  }

}
