import * as vscode from 'vscode';

/**
 * Utility to get all enum values from a TypeScript enum
 */
function enumValues<T extends Record<string, string | number>>(e: T): Array<T[keyof T]> {
  const names = Object.keys(e).filter(k => Number.isNaN(Number(k))) as Array<keyof T>;
  return names.map(k => e[k]);
}

/**
 * Options for formatting symbol hierarchies
 */
export interface HierarchyFormatOptions {
  maxDepth: number;
  showHierarchy: boolean;
  includeBody: boolean;
  maxSymbols: number;
  includeKinds?: number[];
  excludeKinds?: number[];
}

/**
 * Result from formatting symbols with hierarchy
 */
export interface FormattedSymbolsResult {
  formatted: string;
  symbolCount: number;
  truncated: boolean;
}

/**
 * Static utility class for symbol formatting and kind conversion operations.
 * Provides centralized logic for converting between VS Code SymbolKind and string representations.
 */
export class SymbolFormatter {
  /**
   * Mapping from VS Code SymbolKind to human-readable string names
   */
  private static readonly SYMBOL_KIND_MAP: Record<vscode.SymbolKind, string> = {
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
    [vscode.SymbolKind.EnumMember]: 'enum_member',
    [vscode.SymbolKind.Struct]: 'struct',
    [vscode.SymbolKind.Event]: 'event',
    [vscode.SymbolKind.Operator]: 'operator',
    [vscode.SymbolKind.TypeParameter]: 'type_parameter'
  };

  /**
   * Convert VS Code SymbolKind to human-readable string name
   * @param kind - VS Code SymbolKind number
   * @returns Human-readable string representation
   */
  static getSymbolKindName(kind: vscode.SymbolKind): string {
    return this.SYMBOL_KIND_MAP[kind] || 'unknown';
  }

  /**
   * Convert string representation back to VS Code SymbolKind number
   * @param kindString - String representation of symbol kind
   * @returns VS Code SymbolKind number, or undefined if not found
   */
  static convertKindStringToNumber(kindString: string): number | undefined {
    const allKinds = enumValues(vscode.SymbolKind) as number[];
    const targetString = kindString.toLowerCase();
    return allKinds.find(kind => this.getSymbolKindName(kind) === targetString);
  }

  /**
   * Format a symbol path array into a consistent string representation
   * @param symbolPath - Array of symbol names representing the hierarchical path
   * @returns Formatted path string using '/' separator
   */
  static formatSymbolPath(symbolPath: string[]): string {
    return symbolPath.join('/');
  }

  /**
   * Extract top-level symbols from a mixed array of DocumentSymbol or SymbolInformation
   * @param symbols - Array of symbols from VS Code LSP
   * @returns Array of simplified symbol objects with name and kind
   */
  static extractTopLevelSymbols(
    symbols: vscode.DocumentSymbol[] | vscode.SymbolInformation[]
  ): Array<{ name: string; kind: vscode.SymbolKind }> {
    if (!symbols || symbols.length === 0) {
      return [];
    }

    // Check if we have DocumentSymbol or SymbolInformation
    const firstSymbol = symbols[0];
    if (!firstSymbol) {
      return [];
    }

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
   * Format symbols with hierarchy support for enhanced GetSymbolsOverviewTool
   * Returns formatted string with newlines using lineNumber: symbolName format
   * @param symbols - Array of DocumentSymbols
   * @param document - TextDocument for body extraction and line numbers
   * @param options - Formatting options
   * @returns Object with formatted string, symbol count, and truncation status
   */
  static formatSymbolsWithHierarchy(
    symbols: vscode.DocumentSymbol[],
    document: vscode.TextDocument | undefined,
    options: HierarchyFormatOptions
  ): FormattedSymbolsResult {
    const lines: string[] = [];
    let symbolCount = 0;
    let truncated = false;

    const processSymbols = (
      symbolList: vscode.DocumentSymbol[],
      currentDepth: number = 0
    ): void => {
      if (symbolCount >= options.maxSymbols) {
        truncated = true;
        return;
      }
      if (options.maxDepth >= 0 && currentDepth > options.maxDepth) return;

      for (const symbol of symbolList) {
        if (symbolCount >= options.maxSymbols) {
          truncated = true;
          break;
        }

        // Apply kind filtering
        if (options.excludeKinds?.includes(symbol.kind)) continue;
        if (options.includeKinds && !options.includeKinds.includes(symbol.kind)) continue;

        // Get line number from symbol range
        const lineNumber = symbol.range.start.line + 1; // Convert from 0-based to 1-based

        // Format symbol line with hierarchy indentation
        const indent = options.showHierarchy ? '  '.repeat(currentDepth) : '';
        const symbolType = this.getSymbolKindName(symbol.kind);
        const symbolLine = `${lineNumber}: ${indent}${symbol.name} (${symbolType})`;
        lines.push(symbolLine);
        symbolCount++;

        // Add body if requested and available
        if (options.includeBody && document && symbol.range) {
          try {
            const body = document.getText(symbol.range);
            const bodyLines = body.split('\n');
            const bodyIndent = options.showHierarchy ? '  '.repeat(currentDepth + 1) : '  ';

            // Add first few lines of body with proper indentation
            for (let i = 0; i < Math.min(bodyLines.length, 5); i++) {
              const line = bodyLines[i];
              if (line && line.trim()) {
                const bodyLineNumber = lineNumber + i;
                lines.push(`${bodyLineNumber}: ${bodyIndent}${line.trim()}`);
              }
            }

            if (bodyLines.length > 5) {
              lines.push(`${lineNumber + 5}: ${bodyIndent}... (truncated)`);
            }
          } catch (error) {
            // Skip body if extraction fails
          }
        }

        // Recursively process children
        if (symbol.children && symbol.children.length > 0 && symbolCount < options.maxSymbols) {
          processSymbols(symbol.children, currentDepth + 1);
        }
      }
    };

    processSymbols(symbols);
    return {
      formatted: lines.join('\n'),
      symbolCount,
      truncated
    };
  }  /**
   * Get all available symbol kind names for validation or UI purposes
   * @returns Array of all supported symbol kind string names
   */
  static getAllSymbolKindNames(): string[] {
    return Object.values(this.SYMBOL_KIND_MAP);
  }

  /**
   * Check if a symbol should be included based on kind filtering
   * @param symbolKind - VS Code SymbolKind to check
   * @param includeKinds - Optional array of kinds to include
   * @param excludeKinds - Optional array of kinds to exclude (takes precedence)
   * @returns True if symbol should be included
   */
  static shouldIncludeSymbolKind(
    symbolKind: vscode.SymbolKind,
    includeKinds?: number[],
    excludeKinds?: number[]
  ): boolean {
    if (excludeKinds?.includes(symbolKind)) {
      return false;
    }
    if (includeKinds && !includeKinds.includes(symbolKind)) {
      return false;
    }
    return true;
  }
}