import { XmlUtils } from './xmlUtils';

/**
 * Utility class for formatting search pattern results into structured XML output
 * optimized for LLM parsing and understanding.
 */
export class SearchResultFormatter {
  /**
   * Format search pattern results into structured XML format for LLM consumption
   * @param matches Array of matches with file paths, line numbers, and content
   * @returns Array of formatted XML strings representing the search results
   */
  formatResults(
    matches: Array<{ filePath: string; lineNumber: number; line: string }>
  ): string[] {
    if (matches.length === 0) {
      return [this.formatNoMatches()];
    }

    // Group matches by file for better organization
    const groupedMatches = new Map<string, Array<{ lineNumber: number; line: string }>>();
    
    for (const match of matches) {
      if (!groupedMatches.has(match.filePath)) {
        groupedMatches.set(match.filePath, []);
      }
      groupedMatches.get(match.filePath)!.push({
        lineNumber: match.lineNumber,
        line: match.line
      });
    }

    const results: string[] = [];

    // Create XML for each file
    for (const [filePath, fileMatches] of groupedMatches) {
      const xmlParts = [
        '<search_result>',
        `  <file>${XmlUtils.escapeXml(filePath)}</file>`,
        `  <matches count="${fileMatches.length}">`
      ];

      // Add each match with line number and content
      for (const match of fileMatches) {
        xmlParts.push(`    <match>`);
        xmlParts.push(`      <line_number>${match.lineNumber}</line_number>`);
        xmlParts.push(`      <content>${XmlUtils.escapeXml(match.line)}</content>`);
        xmlParts.push(`    </match>`);
      }

      xmlParts.push(`  </matches>`);
      xmlParts.push('</search_result>');

      results.push(xmlParts.join('\n'));
    }

    return results;
  }

  /**
   * Format a 'no matches found' message
   * @returns Formatted XML message indicating no matches
   */
  formatNoMatches(): string {
    const xmlParts = [
      '<search_result>',
      `  <matches count="0">`,
      `    <message>No matches found for the specified pattern</message>`,
      `  </matches>`,
      '</search_result>'
    ];

    return xmlParts.join('\n');
  }

  /**
   * Format an error result when search fails
   * @param error The error that occurred
   * @returns Formatted XML string with error information
   */
  formatError(error: unknown): string {
    const errorMessage = error instanceof Error ? error.message : String(error);

    const xmlParts = [
      '<search_result>',
      `  <error>Error searching for pattern: ${XmlUtils.escapeXml(errorMessage)}</error>`,
      '</search_result>'
    ];

    return xmlParts.join('\n');
  }
}