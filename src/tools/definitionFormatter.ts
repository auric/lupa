import * as vscode from 'vscode';

/**
 * Utility class for formatting symbol definitions into structured JSON output
 * optimized for LLM parsing and understanding with minimal token usage.
 */
export class DefinitionFormatter {
  /**
   * Format a symbol definition into structured JSON format for LLM consumption
   * @param filePath The relative file path containing the symbol
   * @param symbolName The name of the symbol
   * @param range The range of the symbol definition
   * @param symbolBody The full body/content of the symbol (optional)
   * @param includeFullBody Whether to include the full symbol body
   * @returns JSON string representing the symbol definition
   */
  formatDefinition(
    filePath: string,
    range: vscode.Range,
    symbolBody: string | undefined = undefined,
    includeFullBody: boolean = true
  ): string {
    // Use 1-based line numbers for better human readability
    const startLine = range.start.line + 1;
    const startCharacter = range.start.character;

    const definition = {
      file: filePath,
      location: {
        line: startLine,
        character: startCharacter
      }
    };

    if (includeFullBody && symbolBody !== undefined) {
      // Format body with line numbers for consistency
      const bodyWithLineNumbers = this.formatBodyWithLineNumbers(symbolBody, startLine);
      (definition as any).body = bodyWithLineNumbers;
    }

    return JSON.stringify(definition, null, 2);
  }

  /**
   * Format symbol body content with line numbers in "lineNumber: content" format
   */
  private formatBodyWithLineNumbers(content: string, startLine: number): string[] {
    const lines = content.split('\n');
    return lines.map((line, index) => `${startLine + index}: ${line}`);
  }

  /**
   * Format an error definition when symbol content cannot be read
   * @param filePath The relative file path containing the symbol
   * @param symbolName The name of the symbol
   * @param range The range of the symbol definition
   * @param error The error that occurred
   * @returns JSON string with error information
   */
  formatErrorDefinition(
    filePath: string,
    symbolName: string,
    range: vscode.Range,
    error: unknown
  ): string {
    const startLine = range.start.line + 1;
    const startCharacter = range.start.character;
    const errorMessage = error instanceof Error ? error.message : String(error);

    const errorDefinition = {
      file: filePath,
      location: {
        line: startLine,
        character: startCharacter
      },
      error: `Could not read file content: ${errorMessage}`
    };

    return JSON.stringify(errorDefinition, null, 2);
  }

  /**
   * Format a 'symbol not found' message
   * @param symbolName The name of the symbol that was not found
   * @returns Simple string error message
   */
  formatNotFoundMessage(symbolName: string): string {
    return `Symbol '${symbolName}' not found`;
  }

}