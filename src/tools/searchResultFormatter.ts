/**
 * Utility class for formatting search pattern results into structured JSON output
 * optimized for LLM parsing and understanding with minimal token usage.
 */
export class SearchResultFormatter {
  /**
   * Format search pattern results into structured JSON format for LLM consumption
   * @param matches Array of matches with file paths, line numbers, and content
   * @returns Array of JSON strings representing the search results
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

    // Create simplified JSON structure for each file
    for (const [filePath, fileMatches] of groupedMatches) {
      const searchResult = {
        file: filePath,
        matches: fileMatches.map(match => `${match.lineNumber}: ${match.line}`)
      };

      results.push(JSON.stringify(searchResult, null, 2));
    }

    return results;
  }

  /**
   * Format a 'no matches found' message
   * @returns Simple string message indicating no matches
   */
  formatNoMatches(): string {
    return 'No matches found for the specified pattern';
  }

  /**
   * Format an error result when search fails
   * @param error The error that occurred
   * @returns Simple string error message
   */
  formatError(error: unknown): string {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return `Error searching for pattern: ${errorMessage}`;
  }
}