import { z } from 'zod';
import * as path from 'path';
import * as vscode from 'vscode';
import { BaseTool } from './baseTool';
import { GitOperationsManager } from '../services/gitOperationsManager';
import { PathSanitizer } from '../utils/pathSanitizer';
import { SymbolExtractor } from '../utils/symbolExtractor';
import { SymbolFormatter } from '../utils/symbolFormatter';
import { CodeFileUtils } from '../utils/codeFileUtils';

/**
 * Enhanced tool that provides a configurable overview of symbols in a file or directory.
 * Supports hierarchy control, symbol filtering, body inclusion, and LLM-optimized output formatting.
 * Uses lineNumber: symbolName format for precise code references.
 * Respects .gitignore and other ignore files, prevents directory traversal attacks.
 */
export class GetSymbolsOverviewTool extends BaseTool {
  name = 'get_symbols_overview';
  description = `Get a configurable overview of symbols (classes, functions, methods, etc.) in a file or directory.
Supports hierarchy control, symbol filtering, and body inclusion for detailed code analysis.
Output format: "lineNumber: symbolName (symbolType)" with optional indentation for hierarchy.
Respects .gitignore files and provides LLM-optimized formatting for code review.`;

  schema = z.object({
    path: z.string().min(1, 'Path cannot be empty').describe('The relative path to the file or directory to get symbols overview for (e.g., "src", "src/services", "src/tools/findSymbolTool.ts")'),
    max_depth: z.number().int().min(-1).default(0).optional().describe('Symbol hierarchy depth: 0=top-level only, 1=include direct children, -1=unlimited depth'),
    include_body: z.boolean().default(false).optional().describe('Include symbol source code for implementation details. Warning: significantly increases response size.'),
    include_kinds: z.array(z.string()).optional().describe('Include only these symbol types: "class", "function", "method", "interface", "property", "variable", "constant", "enum"'),
    exclude_kinds: z.array(z.string()).optional().describe('Exclude these symbol types. Takes precedence over include_kinds.'),
    max_symbols: z.number().int().min(1).default(100).optional().describe('Maximum number of symbols to return to prevent overwhelming output'),
    show_hierarchy: z.boolean().default(true).optional().describe('Show indented hierarchy structure vs flat list')
  });

  constructor(
    private readonly gitOperationsManager: GitOperationsManager,
    private readonly symbolExtractor: SymbolExtractor
  ) {
    super();
  }

  async execute(args: z.infer<typeof this.schema>): Promise<string> {
    // Validate arguments against schema - let validation errors bubble up
    const validationResult = this.schema.safeParse(args);
    if (!validationResult.success) {
      throw new Error(validationResult.error.issues.map(e => e.message).join(', '));
    }

    try {
      const {
        path: relativePath,
        max_depth: maxDepth,
        include_body: includeBody,
        include_kinds: includeKindsStrings,
        exclude_kinds: excludeKindsStrings,
        max_symbols: maxSymbols,
        show_hierarchy: showHierarchy
      } = validationResult.data;

      // Convert string kinds to numbers
      const includeKinds = includeKindsStrings?.map(kind => SymbolFormatter.convertKindStringToNumber(kind)).filter(k => k !== undefined) as number[] | undefined;
      const excludeKinds = excludeKindsStrings?.map(kind => SymbolFormatter.convertKindStringToNumber(kind)).filter(k => k !== undefined) as number[] | undefined;

      // Sanitize the relative path to prevent directory traversal attacks
      const sanitizedPath = PathSanitizer.sanitizePath(relativePath);

      // Get symbols overview using enhanced utilities
      const result = await this.getEnhancedSymbolsOverview(sanitizedPath, {
        maxDepth: maxDepth || 0,
        showHierarchy: showHierarchy ?? true,
        includeBody: includeBody || false,
        maxSymbols: maxSymbols || 100,
        includeKinds,
        excludeKinds
      });

      return result;

    } catch (error) {
      return `Error getting symbols overview: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /**
   * Get enhanced symbols overview for the specified path using new utilities
   */
  private async getEnhancedSymbolsOverview(
    relativePath: string, 
    options: {
      maxDepth: number;
      showHierarchy: boolean;
      includeBody: boolean;
      maxSymbols: number;
      includeKinds?: number[];
      excludeKinds?: number[];
    }
  ): Promise<string> {
    try {
      const gitRootDirectory = this.symbolExtractor.getGitRootPath();
      if (!gitRootDirectory) {
        throw new Error('Git repository not found');
      }

      const targetPath = path.join(gitRootDirectory, relativePath);
      const stat = await this.symbolExtractor.getPathStat(targetPath);
      
      if (!stat) {
        throw new Error(`Path '${relativePath}' not found`);
      }

      const allResults: string[] = [];

      if (stat.type === vscode.FileType.File) {
        // Single file - get its symbols with enhanced formatting
        const fileUri = vscode.Uri.file(targetPath);
        const { symbols, document } = await this.symbolExtractor.extractSymbolsWithContext(fileUri);
        
        if (symbols.length > 0 && 'children' in symbols[0]) {
          const formattedOutput = SymbolFormatter.formatSymbolsWithHierarchy(
            symbols as vscode.DocumentSymbol[],
            document,
            options
          );
          
          if (formattedOutput) {
            allResults.push(`${relativePath}:`);
            allResults.push(formattedOutput);
          }
        }
      } else if (stat.type === vscode.FileType.Directory) {
        // Directory - get symbols from all files using SymbolExtractor
        const directoryResults = await this.symbolExtractor.getDirectorySymbols(targetPath, relativePath);
        
        // Sort results by file path for consistent output
        const sortedResults = directoryResults.sort((a, b) => a.filePath.localeCompare(b.filePath));
        
        for (const { filePath, symbols } of sortedResults) {
          if (symbols.length === 0) continue;
          
          // Get document for body extraction if needed
          const fullPath = path.join(gitRootDirectory, filePath);
          const fileUri = vscode.Uri.file(fullPath);
          const document = options.includeBody ? await this.symbolExtractor.getTextDocument(fileUri) : undefined;
          
          // Only process DocumentSymbols for hierarchy (SymbolInformation doesn't have hierarchy)
          if (symbols.length > 0 && 'children' in symbols[0]) {
            const formattedOutput = SymbolFormatter.formatSymbolsWithHierarchy(
              symbols as vscode.DocumentSymbol[],
              document,
              options
            );
            
            if (formattedOutput) {
              allResults.push(`${filePath}:`);
              allResults.push(formattedOutput);
              allResults.push(''); // Empty line between files
            }
          }
        }
        
        // Remove trailing empty line
        if (allResults.length > 0 && allResults[allResults.length - 1] === '') {
          allResults.pop();
        }
      }

      return allResults.length > 0 ? allResults.join('\n') : 'No symbols found';

    } catch (error) {
      throw new Error(`Failed to get symbols overview for '${relativePath}': ${error instanceof Error ? error.message : String(error)}`);
    }
  }

}