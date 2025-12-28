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
 * Represents a basic symbol match without document context
 */
export interface BasicSymbolMatch {
  symbol: vscode.DocumentSymbol;
  namePath: string;
}

/**
 * Represents a symbol match with full context information
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
  // Complex symbol name matching removed - using simple isExactSymbolMatch for all cases

  /**
   * Smart symbol name matching that handles function signatures
   * @param symbolName - Actual symbol name (e.g., "Shutdown()" or "BShutdownIfAllPipesClosed()")
   * @param targetName - Target name to match (e.g., "Shutdown")
   * @returns True if target matches as exact symbol name, not substring
   */
  static isExactSymbolMatch(symbolName: string, targetName: string): boolean {
    // Exact match first (fastest path)
    if (symbolName === targetName) {
      return true;
    }

    // Check if symbol starts with target name
    if (!symbolName.startsWith(targetName)) {
      return false;
    }

    // If symbol is longer than target, check that the next character indicates end of identifier
    // This prevents "Shutdown" from matching "ShutdownMethod" but allows "Shutdown()", "Shutdown.Service", etc.
    if (symbolName.length > targetName.length) {
      const nextChar = symbolName[targetName.length] ?? '';
      // Reject if followed by alphanumeric or underscore (indicates we're in middle of different identifier)
      // Allow any other character (punctuation, operators, etc.) - this handles all languages universally
      return !/^[a-zA-Z0-9_]/.test(nextChar);
    }

    return false;
  }

  // Complex child symbol inclusion removed - handled simply in document recursion

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

  // Complex tree traversal methods removed - replaced with simple workspace symbol matching
  // and simple document symbol recursion in FindSymbolTool

  // Complex path matching methods removed - replaced with simple array subsequence matching

  // Complex child addition methods removed - no longer needed with simplified approach

  /**
   * Clean symbol name by removing function signatures and templates for output
   * Makes name_path parameter-agnostic like competitor tools (Serena MCP)
   * @param symbolName - Raw symbol name (e.g., "Shutdown()", "method<T>", "func(int, string)")
   * @returns Clean symbol name (e.g., "Shutdown", "method", "func")
   */
  static cleanSymbolName(symbolName: string): string {
    // Remove function signatures: method() or method(params...)
    // Remove template parameters: method<T> or method<T, U>
    // Remove array brackets: array[index]
    // Remove other common suffixes but preserve the core identifier
    return symbolName
      .replace(/\([^)]*\).*$/, '')  // Remove (params) and everything after
      .replace(/<[^>]*>.*$/, '')    // Remove <templates> and everything after
      .replace(/\[[^\]]*\].*$/, '') // Remove [arrays] and everything after
      .replace(/\s+.*$/, '')        // Remove anything after whitespace
      .trim();
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

  /**
   * Parse container name from SymbolInformation into constituent parts
   * Handles different separators: "Namespace::Class", "Namespace.Class", etc.
   * @param containerName - Container name from SymbolInformation
   * @returns Array of container parts, empty if no container
   */
  static parseContainerName(containerName: string | undefined): string[] {
    if (!containerName || containerName.trim() === '') {
      return [];
    }

    // Handle different namespace separators used across languages
    // Split on :: (C++), . (C#/Java), \ or / (some tools)
    return containerName
      .split(/[::.\\\/]/)
      .map(part => part.trim())
      .filter(part => part.length > 0);
  }

  /**
   * Check if a container name matches a target container pattern
   * @param containerName - Container name from SymbolInformation
   * @param targetContainer - Target container name to match
   * @returns True if container matches target
   */
  static matchesContainer(containerName: string | undefined, targetContainer: string): boolean {
    if (!containerName) return false;

    // Parse container into parts and check if any part matches target
    const containerParts = this.parseContainerName(containerName);
    return containerParts.some(part => part === targetContainer);
  }

  /**
   * Check if a workspace symbol matches a hierarchical path pattern
   * Uses containerName + name from SymbolInformation directly
   * @param symbol - SymbolInformation from workspace search
   * @param pathSegments - Target path segments (e.g., ["MyClass", "method"])
   * @returns True if symbol matches the hierarchical pattern
   */
  static matchesWorkspaceSymbol(symbol: vscode.SymbolInformation, pathSegments: string[]): boolean {
    if (pathSegments.length === 0) {
      return false;
    }

    if (pathSegments.length === 1) {
      const target = pathSegments[0]!;
      return this.isExactSymbolMatch(symbol.name, target);
    }

    if (pathSegments.length === 2) {
      // Most common case: "Container/symbol"
      const targetContainer = pathSegments[0]!;
      const targetSymbol = pathSegments[1]!;
      return this.matchesContainer(symbol.containerName, targetContainer) &&
        this.isExactSymbolMatch(symbol.name, targetSymbol);
    }

    // Handle nested paths: ["Outer", "Inner", "Class", "method"]
    return this.matchesNestedPath(symbol.containerName, symbol.name, pathSegments);
  }

  /**
   * Check if a workspace symbol matches a nested hierarchical path
   * @param containerName - Container name from SymbolInformation
   * @param symbolName - Symbol name from SymbolInformation
   * @param pathSegments - Target path segments
   * @returns True if the nested path matches
   */
  static matchesNestedPath(containerName: string | undefined, symbolName: string, pathSegments: string[]): boolean {
    // Build full path: container parts + symbol name
    const containerParts = this.parseContainerName(containerName);
    const fullPath = [...containerParts, symbolName];

    // Check if pathSegments appears as a subsequence in fullPath
    return this.arrayContainsSequence(fullPath, pathSegments);
  }

  /**
   * Check if an array contains another array as a subsequence
   * @param haystack - Array to search in
   * @param needle - Sequence to find
   * @returns True if needle appears as a subsequence in haystack
   */
  static arrayContainsSequence(haystack: string[], needle: string[]): boolean {
    if (needle.length === 0) return false;
    if (haystack.length < needle.length) return false;

    // Try each possible starting position
    for (let start = 0; start <= haystack.length - needle.length; start++) {
      let matches = true;

      for (let i = 0; i < needle.length; i++) {
        const haystackItem = haystack[start + i]!;
        const needleItem = needle[i]!;

        // For the last item (symbol name), use smart symbol matching
        if (i === needle.length - 1) {
          if (!this.isExactSymbolMatch(haystackItem, needleItem)) {
            matches = false;
            break;
          }
        } else {
          // For container names, use exact matching
          if (haystackItem !== needleItem) {
            matches = false;
            break;
          }
        }
      }

      if (matches) return true;
    }

    return false;
  }
}