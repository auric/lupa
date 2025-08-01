import { z } from 'zod';
import * as path from 'path';
import * as vscode from 'vscode';
import ignore from 'ignore';
import { BaseTool } from './baseTool';
import { GitOperationsManager } from '../services/gitOperationsManager';
import { PathSanitizer } from '../utils/pathSanitizer';
import { readGitignore } from '../lib/pathUtils';

/**
 * Tool that provides a high-level overview of symbols in a file or directory.
 * Returns a list of top-level symbols (classes, functions, etc.) in the specified path.
 * Respects .gitignore and other ignore files, prevents directory traversal attacks.
 */
export class GetSymbolsOverviewTool extends BaseTool {
  name = 'get_symbols_overview';
  description = 'Get a high-level overview of the symbols (classes, functions, etc.) in a file or directory. Respects .gitignore files.';

  schema = z.object({
    path: z.string().min(1, 'Path cannot be empty').describe('The relative path to the file or directory to get symbols overview for (e.g., "src", "src/services", "src/tools/findSymbolTool.ts")')
  });

  constructor(private readonly gitOperationsManager: GitOperationsManager) {
    super();
  }

  async execute(args: z.infer<typeof this.schema>): Promise<string[]> {
    // Validate arguments against schema - let validation errors bubble up
    const validationResult = this.schema.safeParse(args);
    if (!validationResult.success) {
      throw new Error(validationResult.error.issues.map(e => e.message).join(', '));
    }

    try {
      const { path: relativePath } = validationResult.data;

      // Sanitize the relative path to prevent directory traversal attacks
      const sanitizedPath = PathSanitizer.sanitizePath(relativePath);

      // Get symbols overview using VS Code LSP API
      const result = await this.getSymbolsOverview(sanitizedPath);

      return result;

    } catch (error) {
      return [`Error getting symbols overview: ${error instanceof Error ? error.message : String(error)}`];
    }
  }

  /**
   * Get symbols overview for the specified path using VS Code LSP API
   */
  private async getSymbolsOverview(relativePath: string): Promise<string[]> {
    try {
      const gitRootDirectory = this.gitOperationsManager.getRepository()?.rootUri.fsPath || '';
      if (!gitRootDirectory) {
        throw new Error('Git repository not found');
      }

      const targetPath = path.join(gitRootDirectory, relativePath);
      const targetUri = vscode.Uri.file(targetPath);

      // Check if path is a file or directory
      let stat: vscode.FileStat;
      try {
        stat = await vscode.workspace.fs.stat(targetUri);
      } catch (error) {
        throw new Error(`Path '${relativePath}' not found`);
      }

      let results: Array<{ filePath: string; symbols: vscode.DocumentSymbol[] | vscode.SymbolInformation[] }> = [];

      if (stat.type === vscode.FileType.File) {
        // Single file - get its symbols
        const symbols = await this.getFileSymbols(targetUri);
        results.push({ filePath: relativePath, symbols });
      } else if (stat.type === vscode.FileType.Directory) {
        // Directory - get symbols from all files, respecting .gitignore
        results = await this.getDirectorySymbols(targetPath, relativePath);
      }

      // Format the results as a simple list of strings
      return this.formatSymbolsOverview(results);

    } catch (error) {
      throw new Error(`Failed to get symbols overview for '${relativePath}': ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get symbols for a single file using VS Code LSP API
   */
  private async getFileSymbols(fileUri: vscode.Uri): Promise<vscode.DocumentSymbol[] | vscode.SymbolInformation[]> {
    try {
      const symbols = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', fileUri);
      return (symbols as vscode.DocumentSymbol[] | vscode.SymbolInformation[]) || [];
    } catch (error) {
      // Return empty array if no symbols or provider not available
      return [];
    }
  }

  /**
   * Get symbols from all files in a directory, respecting .gitignore
   */
  private async getDirectorySymbols(targetPath: string, relativePath: string): Promise<Array<{ filePath: string; symbols: vscode.DocumentSymbol[] | vscode.SymbolInformation[] }>> {
    const results: Array<{ filePath: string; symbols: vscode.DocumentSymbol[] | vscode.SymbolInformation[] }> = [];

    // Read .gitignore patterns
    const repository = this.gitOperationsManager.getRepository();
    const gitignoreContent = await readGitignore(repository);
    const ig = ignore().add(gitignoreContent);

    // Get all files in directory recursively
    const files = await this.getAllFiles(targetPath, relativePath, ig);

    // Get symbols for each file
    for (const filePath of files) {
      const gitRootDirectory = this.gitOperationsManager.getRepository()?.rootUri.fsPath || '';
      const fullPath = path.join(gitRootDirectory, filePath);
      const fileUri = vscode.Uri.file(fullPath);

      try {
        const symbols = await this.getFileSymbols(fileUri);
        if (symbols.length > 0) {
          results.push({ filePath, symbols });
        }
      } catch (error) {
        // Skip files that can't be processed
        continue;
      }
    }

    return results;
  }

  /**
   * Recursively get all code files in a directory, respecting .gitignore
   */
  private async getAllFiles(targetPath: string, relativePath: string, ig: ReturnType<typeof ignore>, depth: number = 0): Promise<string[]> {
    const files: string[] = [];

    // Prevent infinite recursion by limiting depth
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
          // Recursively process subdirectories with depth tracking
          const subPath = path.join(targetPath, name);
          const subFiles = await this.getAllFiles(subPath, fullPath, ig, depth + 1);
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

  /**
   * Format the symbols overview result as a simple list of strings
   */
  private formatSymbolsOverview(results: Array<{ filePath: string; symbols: vscode.DocumentSymbol[] | vscode.SymbolInformation[] }>): string[] {
    const output: string[] = [];

    if (results.length === 0) {
      return ['No symbols found'];
    }

    // Sort files alphabetically for consistent output
    const sortedResults = results.sort((a, b) => a.filePath.localeCompare(b.filePath));

    for (const { filePath, symbols } of sortedResults) {
      if (symbols.length === 0) {
        continue;
      }

      // Add file header
      output.push(`${filePath}:`);

      // Process symbols (handle both DocumentSymbol and SymbolInformation)
      const topLevelSymbols = this.extractTopLevelSymbols(symbols);

      for (const symbol of topLevelSymbols) {
        const symbolType = this.getSymbolTypeName(symbol.kind);
        output.push(`  - ${symbol.name} (${symbolType})`);
      }

      // Add empty line between files for readability
      output.push('');
    }

    // Remove trailing empty line if present
    if (output.length > 0 && output[output.length - 1] === '') {
      output.pop();
    }

    return output.length > 0 ? output : ['No symbols found'];
  }

  /**
   * Extract top-level symbols from the result
   */
  private extractTopLevelSymbols(symbols: vscode.DocumentSymbol[] | vscode.SymbolInformation[]): Array<{ name: string; kind: vscode.SymbolKind }> {
    if (!symbols || symbols.length === 0) {
      return [];
    }

    // Check if we have DocumentSymbol or SymbolInformation
    const firstSymbol = symbols[0];

    if ('children' in firstSymbol) {
      // DocumentSymbol - return top-level symbols only
      return (symbols as vscode.DocumentSymbol[]).map(symbol => ({
        name: symbol.name,
        kind: symbol.kind
      }));
    } else {
      // SymbolInformation - return all (they don't have hierarchy)
      return (symbols as vscode.SymbolInformation[]).map(symbol => ({
        name: symbol.name,
        kind: symbol.kind
      }));
    }
  }

  /**
   * Convert VS Code SymbolKind to human-readable name
   */
  private getSymbolTypeName(kind: vscode.SymbolKind): string {
    const symbolKinds: Record<vscode.SymbolKind, string> = {
      [vscode.SymbolKind.File]: 'file',
      [vscode.SymbolKind.Module]: 'module',
      [vscode.SymbolKind.Namespace]: 'namespace',
      [vscode.SymbolKind.Package]: 'package',
      [vscode.SymbolKind.Class]: 'class',
      [vscode.SymbolKind.Method]: 'method',
      [vscode.SymbolKind.Property]: 'property',
      [vscode.SymbolKind.Field]: 'field',
      [vscode.SymbolKind.Constructor]: 'constructor',
      [vscode.SymbolKind.Enum]: 'enum',
      [vscode.SymbolKind.Interface]: 'interface',
      [vscode.SymbolKind.Function]: 'function',
      [vscode.SymbolKind.Variable]: 'variable',
      [vscode.SymbolKind.Constant]: 'constant',
      [vscode.SymbolKind.String]: 'string',
      [vscode.SymbolKind.Number]: 'number',
      [vscode.SymbolKind.Boolean]: 'boolean',
      [vscode.SymbolKind.Array]: 'array',
      [vscode.SymbolKind.Object]: 'object',
      [vscode.SymbolKind.Key]: 'key',
      [vscode.SymbolKind.Null]: 'null',
      [vscode.SymbolKind.EnumMember]: 'enum member',
      [vscode.SymbolKind.Struct]: 'struct',
      [vscode.SymbolKind.Event]: 'event',
      [vscode.SymbolKind.Operator]: 'operator',
      [vscode.SymbolKind.TypeParameter]: 'type parameter'
    };

    return symbolKinds[kind] || 'unknown';
  }
}