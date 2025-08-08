import * as vscode from 'vscode';

/**
 * Options for symbol matching operations
 */
export interface MatchOptions {
  checkDetailProperty?: boolean;
  includeChildrenOnParentMatch?: boolean;
  caseSensitive?: boolean;
}

/**
 * Options for symbol search operations
 */
export interface SearchOptions {
  includeKinds?: number[];
  excludeKinds?: number[];
  matchOptions?: MatchOptions;
}

/**
 * Represents a symbol match with context information
 */
export interface SymbolMatch {
  symbol: vscode.DocumentSymbol | vscode.SymbolInformation;
  document?: vscode.TextDocument;
  namePath: string;
  filePath: string;
}

/**
 * Static utility class for enhanced symbol matching operations.
 * Provides advanced matching logic including C++ class context support.
 */
export class SymbolMatcher {
  /**
   * Check if a symbol matches the target name, including detail property for C++ classes
   * @param symbol - VS Code DocumentSymbol to check
   * @param targetName - Name to match against
   * @param options - Matching options
   * @returns True if symbol matches the target name
   */
  static matchesSymbolName(
    symbol: vscode.DocumentSymbol,
    targetName: string,
    options: MatchOptions = {}
  ): boolean {
    const { checkDetailProperty = true, caseSensitive = true } = options;
    
    const normalizeString = (str: string) => caseSensitive ? str : str.toLowerCase();
    const normalizedTarget = normalizeString(targetName);

    // Check primary symbol name
    if (normalizeString(symbol.name) === normalizedTarget) {
      return true;
    }

    // Check detail property (for C++ class/namespace context)
    // Detail typically contains just the class name, e.g., detail = "MyClass" for methods in MyClass
    if (checkDetailProperty && symbol.detail && normalizeString(symbol.detail) === normalizedTarget) {
      return true;
    }

    return false;
  }

  /**
   * Find all child symbols when parent matches (useful for C++ classes)
   * @param symbols - Array of DocumentSymbols to search
   * @param targetName - Name to match against
   * @param matchOptions - Options for matching
   * @returns Array of matching symbols including children when parent matches
   */
  static includeChildSymbolsWhenParentMatches(
    symbols: vscode.DocumentSymbol[],
    targetName: string,
    matchOptions: MatchOptions = {}
  ): vscode.DocumentSymbol[] {
    const results: vscode.DocumentSymbol[] = [];

    const processSymbols = (symbolList: vscode.DocumentSymbol[]): void => {
      for (const symbol of symbolList) {
        const parentMatches = this.matchesSymbolName(symbol, targetName, matchOptions);
        
        if (parentMatches) {
          // Include the parent symbol
          results.push(symbol);
          
          // Include all child symbols if parent matches and option is enabled
          if (matchOptions.includeChildrenOnParentMatch && symbol.children) {
            const addChildren = (children: vscode.DocumentSymbol[]): void => {
              for (const child of children) {
                results.push(child);
                if (child.children) {
                  addChildren(child.children);
                }
              }
            };
            addChildren(symbol.children);
          }
        } else {
          // Check children even if parent doesn't match
          if (symbol.children) {
            processSymbols(symbol.children);
          }
        }
      }
    };

    processSymbols(symbols);
    return results;
  }

  /**
   * Filter symbols by kind (include/exclude lists)
   * @param symbols - Array of symbols to filter
   * @param includeKinds - Optional array of SymbolKind numbers to include
   * @param excludeKinds - Optional array of SymbolKind numbers to exclude (takes precedence)
   * @returns Filtered array of symbols
   */
  static filterSymbolsByKind<T extends { kind: vscode.SymbolKind }>(
    symbols: T[],
    includeKinds?: number[],
    excludeKinds?: number[]
  ): T[] {
    return symbols.filter(symbol => {
      // Exclude takes precedence
      if (excludeKinds?.includes(symbol.kind)) {
        return false;
      }
      
      // If include list exists, symbol must be in it
      if (includeKinds && !includeKinds.includes(symbol.kind)) {
        return false;
      }
      
      return true;
    });
  }

  /**
   * Recursively find matching symbols in document symbol tree with enhanced matching
   * @param symbols - Array of DocumentSymbols to search
   * @param pathSegments - Target symbol path segments (typically just one name)
   * @param currentPath - Current path in symbol hierarchy
   * @param matches - Array to collect matches
   * @param document - TextDocument for context
   * @param filePath - File path for context
   * @param options - Search options
   */
  static findMatchingSymbols(
    symbols: vscode.DocumentSymbol[],
    pathSegments: string[],
    currentPath: string[],
    matches: SymbolMatch[],
    document: vscode.TextDocument,
    filePath: string,
    options: SearchOptions = {}
  ): void {
    const { includeKinds, excludeKinds, matchOptions = {} } = options;

    for (const symbol of symbols) {
      // Apply kind filtering early
      if (excludeKinds?.includes(symbol.kind)) continue;
      if (includeKinds && !includeKinds.includes(symbol.kind)) continue;

      const symbolPath = [...currentPath, symbol.name];

      // Check if this symbol matches using enhanced matching
      if (this.matchesNamePath(symbolPath, pathSegments, symbol, matchOptions)) {
        matches.push({
          symbol,
          document,
          namePath: symbolPath.join('/'),
          filePath
        });

        // If parent matches and option enabled, include all children
        if (matchOptions.includeChildrenOnParentMatch && symbol.children) {
          this.addAllChildrenToMatches(
            symbol.children,
            symbolPath,
            matches,
            document,
            filePath,
            includeKinds,
            excludeKinds
          );
        }
      }

      // Recursively check children (if not already processed above)
      if (symbol.children && symbol.children.length > 0 && !matchOptions.includeChildrenOnParentMatch) {
        this.findMatchingSymbols(
          symbol.children,
          pathSegments,
          symbolPath,
          matches,
          document,
          filePath,
          options
        );
      }
    }
  }

  /**
   * Check if a symbol path matches the target path segments with enhanced matching
   * @param symbolPath - Current symbol path
   * @param pathSegments - Target path segments
   * @param symbol - The actual symbol for enhanced matching
   * @param matchOptions - Matching options
   * @returns True if paths match
   */
  private static matchesNamePath(
    symbolPath: string[],
    pathSegments: string[],
    symbol: vscode.DocumentSymbol,
    matchOptions: MatchOptions = {}
  ): boolean {
    if (pathSegments.length === 0) return false;
    if (pathSegments.length > 1) return false; // Only support single symbol names

    const targetName = pathSegments[0];
    
    // Use enhanced matching that checks both name and detail
    return this.matchesSymbolName(symbol, targetName, matchOptions);
  }

  /**
   * Add all children symbols to matches (used when parent matches)
   * @param children - Child symbols to add
   * @param parentPath - Parent symbol path
   * @param matches - Array to collect matches
   * @param document - TextDocument for context
   * @param filePath - File path for context
   * @param includeKinds - Optional kinds to include
   * @param excludeKinds - Optional kinds to exclude
   */
  private static addAllChildrenToMatches(
    children: vscode.DocumentSymbol[],
    parentPath: string[],
    matches: SymbolMatch[],
    document: vscode.TextDocument,
    filePath: string,
    includeKinds?: number[],
    excludeKinds?: number[]
  ): void {
    for (const child of children) {
      // Apply kind filtering
      if (excludeKinds?.includes(child.kind)) continue;
      if (includeKinds && !includeKinds.includes(child.kind)) continue;

      const childPath = [...parentPath, child.name];
      matches.push({
        symbol: child,
        document,
        namePath: childPath.join('/'),
        filePath
      });

      // Recursively add grandchildren
      if (child.children) {
        this.addAllChildrenToMatches(
          child.children,
          childPath,
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
   * Check if symbol is a parent type that typically contains other symbols
   * @param symbolKind - VS Code SymbolKind to check
   * @returns True if symbol is typically a container (class, namespace, etc.)
   */
  static isContainerSymbol(symbolKind: vscode.SymbolKind): boolean {
    return [
      vscode.SymbolKind.Class,
      vscode.SymbolKind.Interface,
      vscode.SymbolKind.Namespace,
      vscode.SymbolKind.Module,
      vscode.SymbolKind.Enum,
      vscode.SymbolKind.Struct
    ].includes(symbolKind);
  }
}