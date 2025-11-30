/**
 * Centralized output formatter for tool responses.
 * Ensures consistent formatting across all tools that return file/symbol content.
 *
 * Standard format:
 * - File content header: `=== {file_path} ===`
 * - Symbol header: `=== {file_path} [{symbol_name} - {kind}] ===`
 * - Line numbers: `{lineNumber}: {content}`
 */

export interface FileContentOptions {
    /** Relative file path */
    filePath: string;
    /** Lines of content */
    lines: string[];
    /** Starting line number (1-based) */
    startLine?: number;
}

export interface SymbolContentOptions {
    /** Relative file path */
    filePath: string;
    /** Symbol name */
    symbolName: string;
    /** Symbol kind (e.g., "function", "class") */
    symbolKind: string;
    /** Symbol's hierarchical name path (e.g., "MyClass/myMethod") */
    namePath?: string;
    /** Symbol body lines */
    bodyLines?: string[];
    /** Starting line number for body (1-based) */
    startLine?: number;
}

export interface SymbolOverviewOptions {
    /** Relative file path */
    filePath: string;
    /** Formatted symbol overview content */
    content: string;
}

export class OutputFormatter {
    /**
     * Format file content with standard header and line numbers.
     * Used by: read_file tool
     *
     * Output format:
     * === path/to/file.ts ===
     * 1: line content
     * 2: line content
     */
    static formatFileContent(options: FileContentOptions): string {
        const { filePath, lines, startLine = 1 } = options;
        const header = this.formatFileHeader(filePath);
        const numberedLines = this.formatLinesWithNumbers(lines, startLine);
        return `${header}\n${numberedLines}`;
    }

    /**
     * Format symbol result with standard header, name path, and optional body.
     * Used by: find_symbol tool
     *
     * Output format:
     * === path/to/file.ts [SymbolName - function] ===
     * Name Path: Parent/SymbolName
     * 1: function code...
     */
    static formatSymbolContent(options: SymbolContentOptions): string {
        const { filePath, symbolName, symbolKind, namePath, bodyLines, startLine = 1 } = options;

        const header = this.formatSymbolHeader(filePath, symbolName, symbolKind);
        const parts = [header];

        if (namePath) {
            parts.push(`Name Path: ${namePath}`);
        }

        if (bodyLines && bodyLines.length > 0) {
            parts.push(this.formatLinesWithNumbers(bodyLines, startLine));
        }

        return parts.join('\n');
    }

    /**
     * Format symbol overview for a file.
     * Used by: get_symbols_overview tool
     *
     * Output format:
     * === path/to/file.ts ===
     * {symbol overview content}
     */
    static formatSymbolOverview(options: SymbolOverviewOptions): string {
        const { filePath, content } = options;
        const header = this.formatFileHeader(filePath);
        return `${header}\n${content}`;
    }

    /**
     * Format multiple symbol overviews for directory listing.
     * Used by: get_symbols_overview tool (directory mode)
     */
    static formatMultipleSymbolOverviews(overviews: SymbolOverviewOptions[]): string {
        return overviews
            .map(overview => this.formatSymbolOverview(overview))
            .join('\n\n');
    }

    /**
     * Format usage location with standard header.
     * Used by: find_usages tool
     *
     * Output format:
     * === path/to/file.ts ===
     * 10: usage context line
     */
    static formatUsageLocation(filePath: string, lines: string[], startLine: number): string {
        const header = this.formatFileHeader(filePath);
        const numberedLines = this.formatLinesWithNumbers(lines, startLine);
        return `${header}\n${numberedLines}`;
    }

    /**
     * Format error for a specific file location.
     * Used by: find_usages tool (when reading fails)
     */
    static formatErrorLocation(filePath: string, errorMessage: string): string {
        const header = this.formatFileHeader(filePath);
        return `${header}\nError: ${errorMessage}`;
    }

    /**
     * Format pre-formatted content (lines already have line numbers).
     * Used by: find_usages tool where context lines are already numbered
     */
    static formatPreformattedContent(filePath: string, preformattedLines: string[]): string {
        const header = this.formatFileHeader(filePath);
        return `${header}\n${preformattedLines.join('\n')}`;
    }

    // ========== Private Helper Methods ==========

    /**
     * Format standard file header: === {filePath} ===
     */
    private static formatFileHeader(filePath: string): string {
        return `=== ${filePath} ===`;
    }

    /**
     * Format symbol header: === {filePath} [{name} - {kind}] ===
     */
    private static formatSymbolHeader(filePath: string, symbolName: string, symbolKind: string): string {
        return `=== ${filePath} [${symbolName} - ${symbolKind}] ===`;
    }

    /**
     * Format lines with line numbers: {lineNumber}: {content}
     */
    private static formatLinesWithNumbers(lines: string[], startLine: number): string {
        return lines
            .map((line, index) => `${startLine + index}: ${line}`)
            .join('\n');
    }
}
