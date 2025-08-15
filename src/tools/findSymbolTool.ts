import { z } from 'zod';
import * as path from 'path';
import * as vscode from 'vscode';
import { BaseTool } from './baseTool';
import { SymbolRangeExpander } from './symbolRangeExpander';
import { DefinitionFormatter } from './definitionFormatter';
import { GitOperationsManager } from '../services/gitOperationsManager';
import { PathSanitizer } from '../utils/pathSanitizer';
import { SymbolExtractor } from '../utils/symbolExtractor';
import { SymbolMatcher, type SymbolMatch, type BasicSymbolMatch } from '../utils/symbolMatcher';
import { SymbolFormatter } from '../utils/symbolFormatter';
import { readGitignore } from '../utils/gitUtils';
import { Log } from '../services/loggingService';
import ignore from 'ignore';

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
      'Hierarchical symbol path pattern supporting: ' +
      '"MyClass" - finds all classes named MyClass anywhere; ' +
      '"MyClass/method" - finds method inside MyClass (MyClass can be nested); ' +
      '"/MyClass/method" - finds method inside top-level MyClass only'
    ),
    relative_path: z.string().default('.').optional().describe(
      'Search scope: "." for entire workspace, or specific path like "src/components" or "src/file.ts"'
    ),
    include_body: z.boolean().default(false).optional().describe(
      'Include symbol source code. Warning: significantly increases response size.'
    ),
    include_children: z.boolean().default(false).optional().describe(
      'Include all child symbols of matched symbols. ' +
      'Example: "MyClass" with include_children=true returns class + all its methods/properties.'
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

  async execute(args: z.infer<typeof this.schema>): Promise<string> {
    // Validate input arguments first
    const validationResult = this.schema.safeParse(args);
    if (!validationResult.success) {
      return `Error: ${validationResult.error.issues.map(e => e.message).join(', ')}`;
    }

    try {
      const {
        name_path: namePath,
        relative_path: relativePath,
        include_body: includeBody,
        include_children: includeChildren,
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
        return `Error: Symbol name cannot be empty`;
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
        return `Symbol '${namePath}' not found`;
      }

      // Format the results
      const formattedResults = await this.formatSymbolResults(symbols, includeBody ?? false, includeChildren ?? false, includeKinds, excludeKinds);

      // Convert FormattedSymbol objects to JSON string
      const resultString = JSON.stringify(formattedResults, null, 2);

      // Apply character limit
      if (maxAnswerChars && resultString.length > maxAnswerChars) {
        // Truncate results to fit within limit
        const truncatedResults = formattedResults.slice(0, Math.floor(formattedResults.length / 2));
        return JSON.stringify(truncatedResults, null, 2);
      }

      return resultString;

    } catch (error) {
      return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /**
   * Parse hierarchical symbol path supporting absolute, relative, and simple paths
   */
  private parseNamePath(namePath: string): string[] {
    const cleaned = namePath.trim();
    if (!cleaned) return [];

    // Split by "/" and filter out empty segments (ignore leading slash)
    const segments = cleaned.split('/').filter(segment => segment.length > 0);

    return segments;
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
   * Filter workspace symbols by gitignore patterns
   * @param symbols - Workspace symbols to filter
   * @param ignorePatterns - Gitignore patterns
   * @returns Filtered symbols that should not be ignored
   */
  private filterSymbolsByGitignore(
    symbols: vscode.SymbolInformation[],
    ignorePatterns: ReturnType<typeof ignore>
  ): vscode.SymbolInformation[] {
    return symbols.filter(symbol => {
      // Get git-relative path for the symbol's file
      const gitRelativePath = this.getGitRelativePath(symbol.location.uri);

      // Validate path format before checking gitignore patterns (same as SymbolExtractor)
      if (ignore.isPathValid(gitRelativePath)) {
        try {
          // Use ignores() method with full path (same as SymbolExtractor)
          if (ignorePatterns.ignores(gitRelativePath)) {
            // Symbol should be ignored
            Log.debug(`[FindSymbolTool] Ignoring symbol ${symbol.name} in ${gitRelativePath} due to gitignore`);
            return false;
          }
        } catch (error) {
          // Log gitignore check failures for debugging but include the symbol
          Log.warn(`Failed to check gitignore for path "${gitRelativePath}":`, error);
        }
      } else {
        // Log invalid paths for debugging but include the symbol
        Log.warn(`Invalid path format for gitignore check: "${gitRelativePath}"`);
      }

      // Include symbol (not ignored)
      return true;
    });
  }

  /**
   * Find symbols in workspace using workspace symbol provider with gitignore filtering
   */
  private async findSymbolsInWorkspace(
    pathSegments: string[],
    includeKinds?: number[],
    excludeKinds?: number[]
  ): Promise<SymbolMatch[]> {
    try {
      const targetSymbolName = pathSegments[pathSegments.length - 1];

      // Load gitignore patterns (same as SymbolExtractor)
      const repository = this.gitOperationsManager.getRepository();
      const gitignoreContent = await readGitignore(repository);
      const ig = ignore().add(gitignoreContent);

      // Debug: Log gitignore patterns loaded
      if (gitignoreContent.trim()) {
        Log.debug(`[FindSymbolTool] Loaded gitignore patterns:`, gitignoreContent.split('\n').filter(line => line.trim() && !line.startsWith('#')));
      }

      // Get workspace symbols with timeout
      let workspaceSymbols: vscode.SymbolInformation[] = [];
      try {
        const symbolsPromise = Promise.resolve(vscode.commands.executeCommand<vscode.SymbolInformation[]>(
          'vscode.executeWorkspaceSymbolProvider',
          targetSymbolName
        ));
        workspaceSymbols = await this.withTimeout(symbolsPromise, SYMBOL_SEARCH_TIMEOUT, 'Workspace symbol search') || [];
      } catch (error) {
        Log.warn('Workspace symbol search failed:', error);
        return [];
      }

      if (workspaceSymbols.length === 0) {
        return [];
      }

      // Filter symbols by gitignore patterns
      const filteredSymbols = this.filterSymbolsByGitignore(workspaceSymbols, ig);
      Log.debug(`[FindSymbolTool] Filtered ${workspaceSymbols.length} symbols to ${filteredSymbols.length} after gitignore`);

      const matches: SymbolMatch[] = [];

      // Process filtered symbols with timeout per file
      for (const symbol of filteredSymbols.slice(0, 50)) { // Limit to first 50 results
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
      Log.warn('Workspace symbol search completely failed:', error);
      return [];
    }
  }

  /**
   * Process individual workspace symbol using direct containerName matching
   * No DocumentSymbol fetching needed - uses SymbolInformation properties directly
   */
  private async processWorkspaceSymbol(
    symbol: vscode.SymbolInformation,
    pathSegments: string[]
  ): Promise<SymbolMatch | null> {
    try {
      // Use direct containerName + name matching (no DocumentSymbol fetching!)
      if (!SymbolMatcher.matchesWorkspaceSymbol(symbol, pathSegments)) {
        return null;
      }

      // Build the clean name path for output
      const cleanSymbolName = SymbolMatcher.cleanSymbolName(symbol.name);
      let namePath: string;

      if (symbol.containerName) {
        // Parse container name and build clean path
        const containerParts = SymbolMatcher.parseContainerName(symbol.containerName);
        namePath = [...containerParts, cleanSymbolName].join('/');
      } else {
        // No container context
        namePath = cleanSymbolName;
      }

      // Get document for body extraction (only if match is confirmed)
      let document: vscode.TextDocument | undefined;
      try {
        document = await vscode.workspace.openTextDocument(symbol.location.uri);
      } catch (error) {
        Log.debug(`Failed to open document for symbol ${symbol.name}:`, error);
        // Don't fail the match just because we can't open the document
      }

      return {
        symbol,
        document,
        namePath,
        filePath: this.getGitRelativePath(symbol.location.uri)
      };
    } catch (error) {
      Log.debug(`Error processing workspace symbol ${symbol.name}:`, error);
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
    const gitRootDirectory = this.symbolExtractor.getGitRootPath();
    if (!gitRootDirectory) return [];

    const sanitizedPath = PathSanitizer.sanitizePath(relativePath);
    const targetPath = path.join(gitRootDirectory, sanitizedPath);
    const symbolName = pathSegments[pathSegments.length - 1];
    const startTime = Date.now();

    try {
      const stat = await this.symbolExtractor.getPathStat(targetPath);
      if (!stat) return [];

      if (stat.type === vscode.FileType.File) {
        // Single file - check with text pre-filtering
        const fileUri = vscode.Uri.file(targetPath);
        return await this.findSymbolsInFileWithPreFilter(fileUri, pathSegments, symbolName, includeKinds, excludeKinds);
      } else if (stat.type === vscode.FileType.Directory) {
        // Directory - search with time control using SymbolExtractor
        const directoryResults = await this.symbolExtractor.getDirectorySymbols(targetPath, sanitizedPath);
        const allMatches: SymbolMatch[] = [];

        for (const { filePath, symbols } of directoryResults) {
          // Time-based execution control
          if (Date.now() - startTime > SPECIFIC_PATH_TIMEOUT) {
            Log.warn(`Symbol search in ${relativePath} stopped after ${SPECIFIC_PATH_TIMEOUT}ms timeout`);
            break;
          }

          // Process symbols using enhanced matching with C++ support
          const fileMatches: SymbolMatch[] = [];
          const fullFilePath = path.join(gitRootDirectory, filePath);
          const fileUri = vscode.Uri.file(fullFilePath);
          const document = await this.symbolExtractor.getTextDocument(fileUri);

          if (symbols.length > 0 && 'children' in symbols[0]) {
            // Use simple recursive document symbol search
            const documentMatches = this.findInDocumentSymbolsRecursive(
              symbols as vscode.DocumentSymbol[],
              pathSegments,
              []
            );

            // Apply kind filtering and convert to SymbolMatch format
            for (const match of documentMatches) {
              // Apply kind filtering
              if (excludeKinds?.includes(match.symbol.kind)) continue;
              if (includeKinds && !includeKinds.includes(match.symbol.kind)) continue;

              allMatches.push({
                symbol: match.symbol,
                document,
                namePath: match.namePath,
                filePath
              });
            }
          }
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

      // Use simple recursive document symbol search
      const documentMatches = this.findInDocumentSymbolsRecursive(
        documentSymbols,
        pathSegments,
        []
      );

      const matches: SymbolMatch[] = [];
      const filePath = this.getGitRelativePath(fileUri);

      // Apply kind filtering and convert to SymbolMatch format
      for (const match of documentMatches) {
        // Apply kind filtering
        if (excludeKinds?.includes(match.symbol.kind)) continue;
        if (includeKinds && !includeKinds.includes(match.symbol.kind)) continue;

        matches.push({
          symbol: match.symbol,
          document,
          namePath: match.namePath,
          filePath
        });
      }

      return matches;
    } catch (error) {
      return [];
    }
  }




  /**
   * Find symbol in document symbols using simple recursive path building
   * Much simpler than the previous complex tree traversal approach
   */
  private findSymbolInDocumentSymbols(
    symbols: vscode.DocumentSymbol[],
    position: vscode.Position,
    pathSegments: string[]
  ): { symbol: vscode.DocumentSymbol; namePath: string } | undefined {
    // Use simple recursive search with path building
    const matches = this.findInDocumentSymbolsRecursive(symbols, pathSegments, []);

    if (matches.length === 0) {
      return undefined;
    }

    // If we have matches, find the one that contains the position (for compatibility)
    for (const match of matches) {
      if (match.symbol.range.contains(position)) {
        return match;
      }
    }

    // If no position-based match, return first match
    return matches[0];
  }

  /**
   * Simple recursive function to find matching symbols with path building
   * @param symbols - DocumentSymbols to search
   * @param pathSegments - Target path segments
   * @param currentPath - Current path being built
   * @returns Array of matching symbols with their paths
   */
  private findInDocumentSymbolsRecursive(
    symbols: vscode.DocumentSymbol[],
    pathSegments: string[],
    currentPath: string[]
  ): { symbol: vscode.DocumentSymbol; namePath: string }[] {
    const matches: { symbol: vscode.DocumentSymbol; namePath: string }[] = [];

    for (const symbol of symbols) {
      // Build simple path by concatenating clean names
      const cleanName = SymbolMatcher.cleanSymbolName(symbol.name);
      const fullPath = [...currentPath, cleanName];

      // Simple array comparison for path matching
      if (this.pathMatchesPattern(fullPath, pathSegments)) {
        matches.push({
          symbol,
          namePath: fullPath.join('/')
        });
      }

      // Recursively search children
      if (symbol.children && symbol.children.length > 0) {
        const childMatches = this.findInDocumentSymbolsRecursive(
          symbol.children,
          pathSegments,
          fullPath
        );
        matches.push(...childMatches);
      }
    }

    return matches;
  }

  /**
   * Check if a built path matches the target pattern
   * @param fullPath - Complete path built during traversal
   * @param pathSegments - Target path segments to match
   * @returns True if the path matches the pattern
   */
  private pathMatchesPattern(fullPath: string[], pathSegments: string[]): boolean {
    if (pathSegments.length === 0) return false;

    if (pathSegments.length === 1) {
      // Simple search: match any path that ends with the target
      const targetName = pathSegments[0];
      const lastName = fullPath[fullPath.length - 1];
      return SymbolMatcher.isExactSymbolMatch(lastName, targetName);
    }

    // For hierarchical patterns, use the same subsequence matching as workspace symbols
    return SymbolMatcher.arrayContainsSequence(fullPath, pathSegments);
  }


  /**
   * Format symbol results for output
   */
  private async formatSymbolResults(
    symbols: SymbolMatch[],
    includeBody: boolean,
    includeChildren: boolean,
    includeKinds: number[] | undefined,
    excludeKinds: number[] | undefined
  ): Promise<FormattedSymbol[]> {
    const results: FormattedSymbol[] = [];

    for (const match of symbols) {
      let body: string | undefined;

      if (includeBody && match.document) {
        try {
          // Get the appropriate range based on symbol type
          const symbolRange = this.getSymbolRange(match.symbol);

          // If this is a SymbolInformation, try to get the DocumentSymbol for better body extraction
          let rangeToUse = symbolRange;
          let shouldExpand = true;

          if (this.isSymbolInformation(match.symbol)) {
            const documentSymbol = await this.fetchDocumentSymbolForRange(match.document, symbolRange);
            if (documentSymbol) {
              rangeToUse = this.getBodyExtractionRange(documentSymbol);
              shouldExpand = this.shouldExpandRange(documentSymbol);
            }
          } else if (this.isDocumentSymbol(match.symbol)) {
            rangeToUse = this.getBodyExtractionRange(match.symbol);
            shouldExpand = this.shouldExpandRange(match.symbol);
          }

          // Get appropriate range - expand only for multi-line definitions
          let finalRange: vscode.Range;
          if (shouldExpand) {
            finalRange = await this.rangeExpander.getFullSymbolRange(match.document, rangeToUse);
          } else {
            finalRange = rangeToUse;
          }
          const rawBody = match.document.getText(finalRange);
          body = this.formatBodyWithLineNumbers(rawBody, finalRange.start.line + 1);
        } catch (error) {
          // If range expansion fails, use the basic range
          try {
            const basicRange = this.getSymbolRange(match.symbol);
            const rawBody = match.document.getText(basicRange);
            body = this.formatBodyWithLineNumbers(rawBody, basicRange.start.line + 1);
          } catch (fallbackError) {
            Log.debug(`Failed to extract body for symbol ${match.symbol.name}:`, fallbackError);
            // Don't include body if extraction fails
          }
        }
      }

      results.push({
        symbol_name: match.symbol.name,
        kind: SymbolFormatter.getSymbolKindName(match.symbol.kind),
        name_path: match.namePath,
        file_path: match.filePath,
        ...(body && { body })
      });

      // Add children if requested and available
      if (includeChildren && match.document) {
        let childrenToProcess: vscode.DocumentSymbol[] = [];

        if (this.isDocumentSymbol(match.symbol) && match.symbol.children) {
          // Already have DocumentSymbol with children
          childrenToProcess = match.symbol.children;
        } else if (this.isSymbolInformation(match.symbol)) {
          // Need to fetch DocumentSymbol to get children
          const symbolRange = this.getSymbolRange(match.symbol);
          const documentSymbol = await this.fetchDocumentSymbolForRange(match.document, symbolRange);
          if (documentSymbol && documentSymbol.children) {
            childrenToProcess = documentSymbol.children;
          }
        }

        if (childrenToProcess.length > 0) {
          const childSymbols = this.collectChildrenSymbols(
            childrenToProcess,
            match.namePath,
            match.document,
            match.filePath,
            includeKinds,
            excludeKinds
          );

          for (const childSymbol of childSymbols) {
            let childBody: string | undefined;

            if (includeBody) {
              try {
                // Get the appropriate range based on symbol type
                const childSymbolRange = this.getSymbolRange(childSymbol.symbol);

                // Get full symbol range including body using SymbolRangeExpander
                const fullRange = await this.rangeExpander.getFullSymbolRange(match.document, childSymbolRange);
                const rawChildBody = match.document.getText(fullRange);
                childBody = this.formatBodyWithLineNumbers(rawChildBody, fullRange.start.line + 1);
              } catch (error) {
                try {
                  const childSymbolRange = this.getSymbolRange(childSymbol.symbol);
                  const rawChildBody = match.document.getText(childSymbolRange);
                  childBody = this.formatBodyWithLineNumbers(rawChildBody, childSymbolRange.start.line + 1);
                } catch (fallbackError) {
                  Log.debug(`Failed to extract body for child symbol ${childSymbol.symbol.name}:`, fallbackError);
                  // Don't include body if extraction fails
                }
              }
            }

            results.push({
              symbol_name: childSymbol.symbol.name,
              kind: SymbolFormatter.getSymbolKindName(childSymbol.symbol.kind),
              name_path: childSymbol.namePath,
              file_path: childSymbol.filePath,
              ...(childBody && { body: childBody })
            });
          }
        }
      }
    }

    return results;
  }

  /**
   * Recursively collect all child symbols with filtering
   */
  private collectChildrenSymbols(
    children: vscode.DocumentSymbol[],
    parentPath: string,
    document: vscode.TextDocument,
    filePath: string,
    includeKinds: number[] | undefined,
    excludeKinds: number[] | undefined
  ): SymbolMatch[] {
    const childSymbols: SymbolMatch[] = [];

    for (const child of children) {
      // Apply kind filtering
      if (excludeKinds?.includes(child.kind)) continue;
      if (includeKinds && !includeKinds.includes(child.kind)) continue;

      // Use clean name for path building
      const cleanChildName = SymbolMatcher.cleanSymbolName(child.name);
      const childPath = `${parentPath}/${cleanChildName}`;

      childSymbols.push({
        symbol: child,
        document,
        namePath: childPath, // Clean path without signatures
        filePath
      });

      // Recursively collect grandchildren
      if (child.children && child.children.length > 0) {
        const grandChildren = this.collectChildrenSymbols(
          child.children,
          childPath,
          document,
          filePath,
          includeKinds,
          excludeKinds
        );
        childSymbols.push(...grandChildren);
      }
    }

    return childSymbols;
  }

  /**
   * Format body text with line numbers in the format 'lineNumber: codeLine'
   */
  private formatBodyWithLineNumbers(body: string, startLineNumber: number): string {
    const lines = body.split('\n');
    const formattedLines = lines.map((line, index) => {
      const lineNumber = startLineNumber + index;
      return `${lineNumber}: ${line}`;
    });

    return formattedLines.join('\n');
  }

  /**
   * Type guard to check if a symbol is a DocumentSymbol
   */
  private isDocumentSymbol(symbol: vscode.DocumentSymbol | vscode.SymbolInformation): symbol is vscode.DocumentSymbol {
    return 'range' in symbol && 'children' in symbol;
  }

  /**
   * Type guard to check if a symbol is a SymbolInformation
   */
  private isSymbolInformation(symbol: vscode.DocumentSymbol | vscode.SymbolInformation): symbol is vscode.SymbolInformation {
    return 'location' in symbol;
  }

  /**
   * Get the range from either DocumentSymbol or SymbolInformation
   */
  private getSymbolRange(symbol: vscode.DocumentSymbol | vscode.SymbolInformation): vscode.Range {
    if (this.isDocumentSymbol(symbol)) {
      return symbol.range;
    } else {
      return symbol.location.range;
    }
  }

  /**
   * Fetch DocumentSymbol for a given range from document symbols
   * Used when we need to get body or children from a SymbolInformation
   */
  private async fetchDocumentSymbolForRange(
    document: vscode.TextDocument,
    targetRange: vscode.Range
  ): Promise<vscode.DocumentSymbol | undefined> {
    try {
      const documentSymbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider',
        document.uri
      );

      if (!documentSymbols || documentSymbols.length === 0) {
        return undefined;
      }

      return this.findMatchingDocumentSymbol(documentSymbols, targetRange);
    } catch (error) {
      Log.debug(`Failed to fetch document symbols for range:`, error);
      return undefined;
    }
  }

  /**
   * Find DocumentSymbol that matches the target range
   * Searches recursively through the document symbol tree
   * Prioritizes the most specific (smallest) symbol that contains the target
   */
  private findMatchingDocumentSymbol(
    documentSymbols: vscode.DocumentSymbol[],
    targetRange: vscode.Range
  ): vscode.DocumentSymbol | undefined {
    let bestMatch: vscode.DocumentSymbol | undefined;
    let bestMatchSize = Number.MAX_VALUE;

    for (const symbol of documentSymbols) {
      // Check if this symbol contains the target range
      const symbolContainsTarget = symbol.range.contains(targetRange) ||
        this.rangesOverlap(symbol.selectionRange, targetRange);

      if (symbolContainsTarget) {
        // Calculate symbol size (smaller is more specific)
        const symbolSize = (symbol.range.end.line - symbol.range.start.line) * 1000 +
          (symbol.range.end.character - symbol.range.start.character);

        // Check children first for more specific matches
        if (symbol.children && symbol.children.length > 0) {
          const childMatch = this.findMatchingDocumentSymbol(symbol.children, targetRange);
          if (childMatch) {
            return childMatch; // Child match is always more specific than parent
          }
        }

        // This symbol matches and no child was more specific
        if (symbolSize < bestMatchSize) {
          bestMatch = symbol;
          bestMatchSize = symbolSize;
        }
      }
    }

    return bestMatch;
  }

  /**
   * Check if two ranges overlap (used for finding matching DocumentSymbol)
   */
  private rangesOverlap(range1: vscode.Range, range2: vscode.Range): boolean {
    // Check if ranges overlap by comparing positions
    return !(
      range1.end.isBefore(range2.start) ||
      range2.end.isBefore(range1.start)
    );
  }

  /**
   * Get the appropriate range for body extraction using language-agnostic approach
   * @param symbol - The DocumentSymbol
   * @returns The range to use for body extraction
   */
  private getBodyExtractionRange(symbol: vscode.DocumentSymbol): vscode.Range {
    // Always use the full range - we'll control expansion logic separately
    return symbol.range;
  }

  /**
   * Determine if we should expand the range for a symbol
   * @param symbol - The DocumentSymbol
   * @returns true if we should expand, false to use exact range
   */
  private shouldExpandRange(symbol: vscode.DocumentSymbol): boolean {
    const lineSpan = symbol.range.end.line - symbol.range.start.line;

    // Don't expand single-line symbols (likely declarations)
    if (lineSpan === 0) {
      return false;
    }

    // Don't expand short methods (likely declarations in headers)
    if ((symbol.kind === vscode.SymbolKind.Method ||
      symbol.kind === vscode.SymbolKind.Function ||
      symbol.kind === vscode.SymbolKind.Constructor) && lineSpan <= 2) {
      return false;
    }

    // Expand multi-line symbols (likely definitions with implementation)
    return true;
  }


  // getCodeFilesInDirectory method now handled by SymbolExtractor utility

  // isCodeFile method now handled by CodeFileUtils utility

}
