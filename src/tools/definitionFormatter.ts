import * as vscode from 'vscode';
import { XmlUtils } from './xmlUtils';

/**
 * Utility class for formatting symbol definitions into structured XML output
 * optimized for LLM parsing and understanding.
 */
export class DefinitionFormatter {
  /**
   * Format a symbol definition into structured XML format for LLM consumption
   * @param filePath The relative file path containing the symbol
   * @param symbolName The name of the symbol
   * @param range The range of the symbol definition
   * @param symbolBody The full body/content of the symbol (optional)
   * @param includeFullBody Whether to include the full symbol body
   * @returns Formatted XML string representing the symbol definition
   */
  formatDefinition(
    filePath: string,
    symbolName: string,
    range: vscode.Range,
    symbolBody: string | undefined = undefined,
    includeFullBody: boolean = true
  ): string {
    // Use 1-based line numbers for better human readability
    const startLine = range.start.line + 1;
    const startCharacter = range.start.character;
    const endLine = range.end.line + 1;
    const endCharacter = range.end.character;

    const xmlParts = [
      '<symbol_definition>',
      `  <file>${XmlUtils.escapeXml(filePath)}</file>`,
      `  <symbol_name>${XmlUtils.escapeXml(symbolName)}</symbol_name>`,
      `  <location>`,
      `    <start_line>${startLine}</start_line>`,
      `    <start_character>${startCharacter}</start_character>`,
      `    <end_line>${endLine}</end_line>`,
      `    <end_character>${endCharacter}</end_character>`,
      `  </location>`
    ];

    if (includeFullBody && symbolBody !== undefined) {
      xmlParts.push(`  <full_body>\n${symbolBody}\n  </full_body>`);
    } else {
      xmlParts.push(`  <full_body>false</full_body>`);
    }

    xmlParts.push('</symbol_definition>');

    return xmlParts.join('\n');
  }

  /**
   * Format an error definition when symbol content cannot be read
   * @param filePath The relative file path containing the symbol
   * @param symbolName The name of the symbol
   * @param range The range of the symbol definition
   * @param error The error that occurred
   * @returns Formatted XML string with error information
   */
  formatErrorDefinition(
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
      '<symbol_definition>',
      `  <file>${XmlUtils.escapeXml(filePath)}</file>`,
      `  <symbol_name>${XmlUtils.escapeXml(symbolName)}</symbol_name>`,
      `  <location>`,
      `    <start_line>${startLine}</start_line>`,
      `    <start_character>${startCharacter}</start_character>`,
      `    <end_line>${endLine}</end_line>`,
      `    <end_character>${endCharacter}</end_character>`,
      `  </location>`,
      `  <error>Could not read file content: ${XmlUtils.escapeXml(errorMessage)}</error>`,
      '</symbol_definition>'
    ].join('\n');
  }

  /**
   * Format a 'symbol not found' message
   * @param symbolName The name of the symbol that was not found
   * @returns Formatted error message
   */
  formatNotFoundMessage(symbolName: string): string {
    return `Symbol '${XmlUtils.escapeXml(symbolName)}' not found`;
  }

}