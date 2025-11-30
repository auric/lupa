import * as vscode from 'vscode';
import { OutputFormatter } from '../utils/outputFormatter';

/**
 * Utility class for formatting symbol usage references into plain string output
 * consistent with read_file format for LLM parsing.
 */
export class UsageFormatter {
  /**
   * Format a symbol usage reference into structured format for LLM consumption
   * @param filePath The relative file path containing the usage
   * @param symbolName The name of the symbol being used (removed from output to avoid redundancy)
   * @param range The range of the symbol usage
   * @param contextLines The lines around the usage for context (already formatted with line numbers)
   * @returns Formatted string representing the symbol usage
   */
  formatUsage(
    filePath: string,
    symbolName: string,
    range: vscode.Range,
    contextLines: string[]
  ): string {
    // contextLines are already formatted as "lineNumber: content", use pre-formatted version
    return OutputFormatter.formatPreformattedContent(filePath, contextLines);
  }

  /**
   * Format an error usage when content cannot be read
   * @param filePath The relative file path containing the usage
   * @param symbolName The name of the symbol
   * @param range The range of the symbol usage
   * @param error The error that occurred
   * @returns Formatted string with error information
   */
  formatErrorUsage(
    filePath: string,
    symbolName: string,
    range: vscode.Range,
    error: unknown
  ): string {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return OutputFormatter.formatErrorLocation(filePath, `Could not read file content: ${errorMessage}`);
  }

  /**
   * Format a 'no usages found' message
   * @param symbolName The name of the symbol for which no usages were found
   * @param filePath Optional file path context
   * @returns Simple string message
   */
  formatNoUsagesMessage(symbolName: string, filePath?: string): string {
    const locationContext = filePath ? ` in ${filePath}` : '';
    return `No usages found for symbol '${symbolName}'${locationContext}`;
  }

  /**
   * Extract context lines around a reference for better understanding
   * @param document The VS Code text document
   * @param range The range of the reference
   * @param contextSize Number of lines before and after to include (default: 2)
   * @returns Context lines as an array of formatted strings using "lineNumber: content" format
   */
  extractContextLines(
    document: vscode.TextDocument,
    range: vscode.Range,
    contextSize: number = 2
  ): string[] {
    const lines = document.getText().split('\n');
    const startLine = Math.max(0, range.start.line - contextSize);
    const endLine = Math.min(lines.length - 1, range.end.line + contextSize);

    const contextLines: string[] = [];
    for (let i = startLine; i <= endLine; i++) {
      const lineNumber = i + 1; // 1-based line numbers
      contextLines.push(`${lineNumber}: ${lines[i]}`);
    }

    return contextLines;
  }

}