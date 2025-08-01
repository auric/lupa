import * as vscode from 'vscode';
import { XmlUtils } from './xmlUtils';

/**
 * Utility class for formatting symbol usage references into structured XML output
 * optimized for LLM parsing and understanding.
 */
export class UsageFormatter {
  /**
   * Format a symbol usage reference into structured XML format for LLM consumption
   * @param filePath The relative file path containing the usage
   * @param symbolName The name of the symbol being used
   * @param range The range of the symbol usage
   * @param contextLines The lines around the usage for context
   * @returns Formatted XML string representing the symbol usage
   */
  formatUsage(
    filePath: string,
    symbolName: string,
    range: vscode.Range,
    contextLines: string
  ): string {
    // Use 1-based line numbers for better human readability
    const startLine = range.start.line + 1;
    const startCharacter = range.start.character;
    const endLine = range.end.line + 1;
    const endCharacter = range.end.character;

    return [
      '<symbol_usage>',
      `  <file>${XmlUtils.escapeXml(filePath)}</file>`,
      `  <symbol_name>${XmlUtils.escapeXml(symbolName)}</symbol_name>`,
      `  <location>`,
      `    <start_line>${startLine}</start_line>`,
      `    <start_character>${startCharacter}</start_character>`,
      `    <end_line>${endLine}</end_line>`,
      `    <end_character>${endCharacter}</end_character>`,
      `  </location>`,
      `  <context>\n${contextLines}\n  </context>`,
      '</symbol_usage>'
    ].join('\n');
  }

  /**
   * Format an error usage when content cannot be read
   * @param filePath The relative file path containing the usage
   * @param symbolName The name of the symbol
   * @param range The range of the symbol usage
   * @param error The error that occurred
   * @returns Formatted XML string with error information
   */
  formatErrorUsage(
    filePath: string,
    symbolName: string,
    range: vscode.Range,
    error: unknown
  ): string {
    const startLine = range.start.line + 1;
    const startCharacter = range.start.character;
    const endLine = range.end.line + 1;
    const endCharacter = range.end.character;

    const errorMessage = error instanceof Error ? error.message : String(error);

    return [
      '<symbol_usage>',
      `  <file>${XmlUtils.escapeXml(filePath)}</file>`,
      `  <symbol_name>${XmlUtils.escapeXml(symbolName)}</symbol_name>`,
      `  <location>`,
      `    <start_line>${startLine}</start_line>`,
      `    <start_character>${startCharacter}</start_character>`,
      `    <end_line>${endLine}</end_line>`,
      `    <end_character>${endCharacter}</end_character>`,
      `  </location>`,
      `  <error>Could not read file content: ${XmlUtils.escapeXml(errorMessage)}</error>`,
      '</symbol_usage>'
    ].join('\n');
  }

  /**
   * Format a 'no usages found' message
   * @param symbolName The name of the symbol for which no usages were found
   * @param filePath Optional file path context
   * @returns Formatted message
   */
  formatNoUsagesMessage(symbolName: string, filePath?: string): string {
    const locationContext = filePath ? ` in ${XmlUtils.escapeXml(filePath)}` : '';
    return `No usages found for symbol '${XmlUtils.escapeXml(symbolName)}'${locationContext}`;
  }

  /**
   * Extract context lines around a reference for better understanding
   * @param document The VS Code text document
   * @param range The range of the reference
   * @param contextSize Number of lines before and after to include (default: 2)
   * @returns Context lines as a formatted string
   */
  extractContextLines(
    document: vscode.TextDocument,
    range: vscode.Range,
    contextSize: number = 2
  ): string {
    const lines = document.getText().split('\n');
    const startLine = Math.max(0, range.start.line - contextSize);
    const endLine = Math.min(lines.length - 1, range.end.line + contextSize);

    const contextLines: string[] = [];
    for (let i = startLine; i <= endLine; i++) {
      const lineNumber = i + 1; // 1-based line numbers
      const prefix = i === range.start.line ? '> ' : '  '; // Highlight the usage line
      contextLines.push(`${prefix}${lineNumber}: ${lines[i]}`);
    }

    return contextLines.join('\n');
  }

}