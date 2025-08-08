import { z } from 'zod';
import * as path from 'path';
import * as vscode from 'vscode';
import { BaseTool } from './baseTool';
import { SymbolRangeExpander } from './symbolRangeExpander';
import { DefinitionFormatter } from './definitionFormatter';
import { GitOperationsManager } from '../services/gitOperationsManager';
import { PathSanitizer } from '../utils/pathSanitizer';
import { SymbolExtractor } from '../utils/symbolExtractor';
import { SymbolMatcher, type SymbolMatch } from '../utils/symbolMatcher';
import { SymbolFormatter } from '../utils/symbolFormatter';

interface FormattedSymbol {
  symbol_name: string;
  kind: string;
  name_path: string;
  file_path: string;
  body?: string;
}

// Timeout constants
const SYMBOL_SEARCH_TIMEOUT = 5000; // 5 seconds total
const FILE_PROCESSING_TIMEOUT = 500; // 500ms per file
const SPECIFIC_PATH_TIMEOUT = 3000; // 3 seconds for specific path search

// Symbol formatting functions now handled by SymbolFormatter utility

/**
 * Enhanced tool that finds symbols by name within the codebase with C++ class context support.
 * Uses VS Code's workspace and document symbol providers for efficient symbol discovery.
 * Now leverages utility classes for improved matching, formatting, and reduced code duplication.
 */
export class FindSymbolTool extends BaseTool {
  name = 'find_symbol';
  description = `Finds code symbols (classes, functions, methods, variables, etc.) by exact name within the codebase.
Searches through the workspace using VS Code's symbol providers and returns detailed information about matching symbols.

Usage examples:
- name_path: "MyClass" - finds all classes named MyClass
- name_path: "calculateTotal" - finds all functions/methods named calculateTotal
- name_path: "API_KEY" - finds all constants named API_KEY

The tool supports filtering by symbol kinds and can be restricted to specific files or directories using the relative_path parameter.`;

  private readonly rangeExpander = new SymbolRangeExpander();
  private readonly formatter = new DefinitionFormatter();

  constructor(
    private readonly gitOperationsManager: GitOperationsManager,
    private readonly symbolExtractor: SymbolExtractor
  ) {
    super();
  }

  schema = z.object({
    name_path: z.string().min(1, 'Name path cannot be empty').describe(
      'Exact symbol name to search for (e.g. "MyClass", "calculateTotal", "API_KEY"). Simple names only, no paths.'
    ),
    relative_path: z.string().default('.').optional().describe(
      'Search scope: "." for entire workspace, or specific path like "src/components" or "src/file.ts"'
    ),
    include_body: z.boolean().default(false).optional().describe(
      'Include symbol source code. Warning: significantly increases response size.'
    ),
    include_kinds: z.array(z.string()).optional().describe(
      'Include only these symbol types: "class", "function", "method", "variable", "constant", "interface", "enum", "property", "field", "constructor"'
    ),
    exclude_kinds: z.array(z.string()).optional().describe(
      'Exclude these symbol types. Takes precedence over include_kinds.'
    ),
    max_answer_chars: z.number().int().min(1000).default(50000).optional().describe(
      'Maximum response size. Results truncated if exceeded.'
    )
  });

  async execute(args: z.infer<typeof this.schema>): Promise<string[]> {
    // Validate input arguments first
    const validationResult = this.schema.safeParse(args);
    if (!validationResult.success) {
      return [`Error: ${validationResult.error.issues.map(e => e.message).join(', ')}`];
    }

    try {
      const {
        name_path: namePath,
        relative_path: relativePath,
        include_body: includeBody,
        include_kinds: includeKindsStrings,
        exclude_kinds: excludeKindsStrings,
        max_answer_chars: maxAnswerChars
      } = validationResult.data;

      // Convert string kinds to numbers using SymbolFormatter
      const includeKinds = includeKindsStrings?.map(kind => SymbolFormatter.convertKindStringToNumber(kind)).filter(k => k !== undefined) as number[] | undefined;
      const excludeKinds = excludeKindsStrings?.map(kind => SymbolFormatter.convertKindStringToNumber(kind)).filter(k => k !== undefined) as number[] | undefined;

      // Parse and validate the hierarchical name path
      const pathSegments = this.parseNamePath(namePath);
      if (pathSegments.length === 0) {
        return [`Error: Symbol name cannot be empty`];
      }

      // Find symbols based on the search scope - Two-path strategy
      let symbols: SymbolMatch[] = [];

      if (relativePath && relativePath !== '.') {
        // Path B: Specific path search with time-controlled processing
        symbols = await this.findSymbolsInPath(pathSegments, relativePath, includeKinds, excludeKinds);
      } else {
        // Path A: Workspace search using VS Code's optimized indexing
        symbols = await this.findSymbolsInWorkspace(pathSegments, includeKinds, excludeKinds);
      }

      if (symbols.length === 0) {
        return [`Symbol '${namePath}' not found`];
      }

      // Format the results
      const formattedResults = await this.formatSymbolResults(symbols, includeBody);

      // Convert FormattedSymbol objects to JSON strings
      const jsonStrings = formattedResults.map(result => JSON.stringify(result));

      // Apply character limit
      const totalLength = jsonStrings.join('').length;
      if (maxAnswerChars && totalLength > maxAnswerChars) {
        // Return limited results instead of error
        const limitedResults = jsonStrings.slice(0, Math.floor(jsonStrings.length / 2));
        return limitedResults;
      }

      return jsonStrings;

    } catch (error) {
      return [`Error: ${error instanceof Error ? error.message : String(error)}`];
    }
  }

  /**
   * Parse simple symbol name (no hierarchical paths supported)
   */
  private parseNamePath(namePath: string): string[] {
    // Only support simple names, no hierarchical paths
    const cleaned = namePath.trim();
    if (!cleaned) return [];

    // Reject hierarchical paths (containing slashes)
    if (cleaned.includes('/')) {
      return []; // Invalid - hierarchical paths not supported
    }

    return [cleaned];
  }

  /**
   * Timeout wrapper for operations
   */
  private withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`${operation} timed out after ${timeoutMs}ms`)), timeoutMs)
      )
    ]);
  }

  /**
   * Get file path relative to git repository root (now using SymbolExtractor)
   */
  private getGitRelativePath(uri: vscode.Uri): string {
    return this.symbolExtractor.getGitRelativePathFromUri(uri);
  }

  /**
   * Find symbols in workspace using workspace symbol provider (Path A - optimized)
   */
  private async findSymbolsInWorkspace(
    pathSegments: string[],
    includeKinds?: number[],
    excludeKinds?: number[]
  ): Promise<SymbolMatch[]> {
    try {
      const targetSymbolName = pathSegments[pathSegments.length - 1];

      // Strategy 1: Try workspace symbol provider with timeout
      let workspaceSymbols: vscode.SymbolInformation[] = [];
      try {
        const symbolsPromise = Promise.resolve(vscode.commands.executeCommand<vscode.SymbolInformation[]>(
          'vscode.executeWorkspaceSymbolProvider',
          targetSymbolName
        ));
        workspaceSymbols = await this.withTimeout(symbolsPromise, SYMBOL_SEARCH_TIMEOUT, 'Workspace symbol search') || [];
      } catch (error) {
        // If workspace symbols fail, return empty - don't fallback
        console.warn('Workspace symbol search failed:', error);
        return [];
      }

      if (workspaceSymbols.length === 0) {
        return [];
      }

      const matches: SymbolMatch[] = [];

      // Process symbols with timeout per file
      for (const symbol of workspaceSymbols.slice(0, 50)) { // Limit to first 50 results
        // Apply kind filtering early
        if (excludeKinds?.includes(symbol.kind)) continue;
        if (includeKinds && !includeKinds.includes(symbol.kind)) continue;

        try {
          const processSymbolPromise = this.processWorkspaceSymbol(symbol, pathSegments);
          const match = await this.withTimeout(processSymbolPromise, FILE_PROCESSING_TIMEOUT, 'Symbol processing');
          if (match) {
            matches.push(match);
          }
        } catch (error) {
          // Skip symbols that timeout or fail to process
          continue;
        }
      }

      return matches;
    } catch (error) {
      console.warn('Workspace symbol search completely failed:', error);
      return [];
    }
  }

  /**
   * Process individual workspace symbol
   */
  private async processWorkspaceSymbol(
    symbol: vscode.SymbolInformation,
    pathSegments: string[]
  ): Promise<SymbolMatch | null> {
    try {
      const document = await vscode.workspace.openTextDocument(symbol.location.uri);
      const documentSymbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider',
        symbol.location.uri
      );

      if (documentSymbols) {
        const match = this.findSymbolInDocumentSymbols(
          documentSymbols,
          symbol.location.range.start,
          pathSegments
        );

        if (match) {
          return {
            symbol: match.symbol,
            document,
            namePath: match.namePath,
            filePath: this.getGitRelativePath(symbol.location.uri)
          };
        }
      }

      // If document symbols don't work, use the workspace symbol directly
      return {
        symbol,
        document,
        namePath: symbol.name,
        filePath: this.getGitRelativePath(symbol.location.uri)
      };
    } catch (error) {
      return null;
    }
  }


  /**
   * Find symbols in a specific file or directory path (Path B - time-controlled)
   */
  private async findSymbolsInPath(
    pathSegments: string[],
    relativePath: string,
    includeKinds?: number[],
    excludeKinds?: number[]
  ): Promise<SymbolMatch[]> {
    const gitRoot = this.gitOperationsManager.getRepository()?.rootUri.fsPath;
    if (!gitRoot) return [];

    const sanitizedPath = PathSanitizer.sanitizePath(relativePath);
    const fullPath = path.join(gitRoot, sanitizedPath);
    const symbolName = pathSegments[pathSegments.length - 1];
    const startTime = Date.now();

    try {
      const targetUri = vscode.Uri.file(fullPath);
      const stat = await vscode.workspace.fs.stat(targetUri);

      if (stat.type === vscode.FileType.File) {
        // Single file - check with text pre-filtering
        return await this.findSymbolsInFileWithPreFilter(targetUri, pathSegments, symbolName, includeKinds, excludeKinds);
      } else if (stat.type === vscode.FileType.Directory) {
        // Directory - search with time control using SymbolExtractor
        const directoryResults = await this.symbolExtractor.getDirectorySymbols(fullPath, sanitizedPath);
        const allMatches: SymbolMatch[] = [];

        for (const { filePath, symbols } of directoryResults) {
          // Time-based execution control
          if (Date.now() - startTime > SPECIFIC_PATH_TIMEOUT) {
            console.warn(`Symbol search in ${relativePath} stopped after ${SPECIFIC_PATH_TIMEOUT}ms timeout`);
            break;
          }

          // Process symbols using enhanced matching with C++ support
          const fileMatches: SymbolMatch[] = [];
          const fullFilePath = path.join(gitRoot, filePath);
          const fileUri = vscode.Uri.file(fullFilePath);
          const document = await this.symbolExtractor.getTextDocument(fileUri);

          if (symbols.length > 0 && 'children' in symbols[0]) {
            // Use SymbolMatcher for enhanced matching
            SymbolMatcher.findMatchingSymbols(
              symbols as vscode.DocumentSymbol[],
              pathSegments,
              [],
              fileMatches,
              document!,
              filePath,
              { includeKinds, excludeKinds, matchOptions: { checkDetailProperty: true } }
            );
          }

          allMatches.push(...fileMatches);
        }

        return allMatches;
      }
    } catch (error) {
      // Path doesn't exist or can't be accessed
      return [];
    }

    return [];
  }

  /**
   * Find symbols within a single file with text pre-filtering
   */
  private async findSymbolsInFileWithPreFilter(
    fileUri: vscode.Uri,
    pathSegments: string[],
    symbolName: string,
    includeKinds?: number[],
    excludeKinds?: number[]
  ): Promise<SymbolMatch[]> {
    try {
      // Quick text pre-check before expensive symbol analysis
      const fileContent = await vscode.workspace.fs.readFile(fileUri);
      const text = fileContent.toString();

      if (!text.includes(symbolName)) {
        return []; // Skip files that don't contain the symbol name
      }

      const document = await vscode.workspace.openTextDocument(fileUri);
      const documentSymbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider',
        fileUri
      );

      if (!documentSymbols || documentSymbols.length === 0) {
        return [];
      }

      const matches: SymbolMatch[] = [];
      this.findMatchingSymbols(
        documentSymbols,
        pathSegments,
        [],
        matches,
        document,
        this.getGitRelativePath(fileUri),
        includeKinds,
        excludeKinds
      );

      return matches;
    } catch (error) {
      return [];
    }
  }

  /**
   * Recursively find matching symbols in document symbol tree
   */
  private findMatchingSymbols(
    symbols: vscode.DocumentSymbol[],
    pathSegments: string[],
    currentPath: string[],
    matches: SymbolMatch[],
    document: vscode.TextDocument,
    filePath: string,
    includeKinds?: number[],
    excludeKinds?: number[]
  ): void {
    for (const symbol of symbols) {
      // Apply kind filtering
      if (excludeKinds?.includes(symbol.kind)) continue;
      if (includeKinds && !includeKinds.includes(symbol.kind)) continue;

      const symbolPath = [...currentPath, symbol.name];

      if (this.matchesNamePath(symbolPath, pathSegments)) {
        matches.push({
          symbol,
          document,
          namePath: symbolPath.join('/'),
          filePath
        });
      }

      // Recursively check children
      if (symbol.children && symbol.children.length > 0) {
        this.findMatchingSymbols(
          symbol.children,
          pathSegments,
          symbolPath,
          matches,
          document,
          filePath,
          includeKinds,
          excludeKinds
        );
      }
    }
  }

  /**
   * Check if a symbol path matches the target symbol name (simplified for single names only)
   */
  private matchesNamePath(symbolPath: string[], pathSegments: string[]): boolean {
    if (pathSegments.length === 0) return false;
    if (pathSegments.length > 1) return false; // Only support single symbol names

    const targetName = pathSegments[0];
    // Check if the symbol name matches (exact match)
    return symbolPath[symbolPath.length - 1] === targetName;
  }


  /**
   * Find symbol in document symbols by position and check path matching
   */
  private findSymbolInDocumentSymbols(
    symbols: vscode.DocumentSymbol[],
    position: vscode.Position,
    pathSegments: string[],
    currentPath: string[] = []
  ): { symbol: vscode.DocumentSymbol; namePath: string } | undefined {
    for (const symbol of symbols) {
      if (symbol.range.contains(position)) {
        const symbolPath = [...currentPath, symbol.name];

        // Check if this symbol matches our path requirements
        const matches = this.matchesNamePath(symbolPath, pathSegments);

        if (matches) {
          return { symbol, namePath: symbolPath.join('/') };
        }

        // Check children if this symbol contains the position
        if (symbol.children) {
          const childMatch = this.findSymbolInDocumentSymbols(
            symbol.children,
            position,
            pathSegments,
            symbolPath
          );
          if (childMatch) return childMatch;
        }
      }
    }
    return undefined;
  }


  /**
   * Format symbol results for output
   */
  private async formatSymbolResults(symbols: SymbolMatch[], includeBody?: boolean): Promise<FormattedSymbol[]> {
    const results: FormattedSymbol[] = [];

    for (const match of symbols) {
      let body: string | undefined;

      if (includeBody && match.document && 'range' in match.symbol) {
        try {
          // Get full symbol range including body
          const fullRange = await this.rangeExpander.getFullSymbolRange(match.document, match.symbol.range);
          body = match.document.getText(fullRange);
        } catch (error) {
          // If range expansion fails, use the basic range
          body = match.document.getText(match.symbol.range);
        }
      }

      results.push({
        symbol_name: match.symbol.name,
        kind: SymbolFormatter.getSymbolKindName(match.symbol.kind),
        name_path: match.namePath,
        file_path: match.filePath,
        ...(body && { body })
      });
    }

    return results;
  }

  // getCodeFilesInDirectory method now handled by SymbolExtractor utility

  // isCodeFile method now handled by CodeFileUtils utility

}
