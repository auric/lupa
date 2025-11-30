import { z } from 'zod';
import * as vscode from 'vscode';
import { BaseTool } from './baseTool';
import { GitOperationsManager } from '../services/gitOperationsManager';
import { FileDiscoverer } from '../utils/fileDiscoverer';
import { CodeFileDetector } from '../utils/codeFileDetector';
import { Repository } from '../types/vscodeGitExtension';
import { ToolResult, toolSuccess, toolError } from '../types/toolResultTypes';

interface SearchMatch {
  file_path: string;
  content: string;
}

/**
 * Enhanced tool for searching regex patterns in the codebase with flexible file filtering.
 * Supports context extraction, gitignore filtering, and code-file-only restrictions.
 *
 * Pattern Matching Logic:
 * - Uses DOTALL flag for multiline pattern matching
 * - Extracts configurable context lines before and after matches
 * - Groups consecutive matches intelligently
 *
 * File Selection Logic:
 * - Flexible glob pattern inclusion/exclusion
 * - Code-only filtering when only_code_files is enabled
 * - Full gitignore compliance
 */
export class SearchForPatternTool extends BaseTool {
  name = 'search_for_pattern';
  description = `Offers flexible search for arbitrary patterns in the codebase, including the possibility to search in non-code files.
Generally, symbolic operations like find_symbol should be preferred if you know which symbols you are looking for.

Pattern Matching Logic:
For each match, the returned result contains the full lines where the pattern is found, plus optionally context lines before and after. The pattern is compiled with DOTALL, meaning dot matches all characters including newlines. Be careful to not use greedy quantifiers unnecessarily - use non-greedy quantifiers like .*? to avoid matching too much content.

File Selection Logic:
Files can be restricted very flexibly. Use only_code_files=true for code symbols. Combine with glob patterns and relative paths for targeted searches. Exclude patterns take precedence over include patterns.`;

  schema = z.object({
    pattern: z.string().min(1, 'Pattern cannot be empty').describe(
      'Regular expression pattern to search for in file contents'
    ),
    lines_before: z.number().int().min(0).max(20).default(0).optional().describe(
      'Number of lines of context to include before each match (default: 0, max: 20)'
    ),
    lines_after: z.number().int().min(0).max(20).default(0).optional().describe(
      'Number of lines of context to include after each match (default: 0, max: 20)'
    ),
    include_files: z.string().default('').optional().describe(
      'Optional glob pattern specifying files to include (e.g., "*.py", "src/**/*.ts"). If empty, all non-ignored files are included.'
    ),
    exclude_files: z.string().default('').optional().describe(
      'Optional glob pattern specifying files to exclude (e.g., "*test*", "**/*_generated.py"). Takes precedence over include_files.'
    ),
    search_path: z.string().default('.').optional().describe(
      'Only search within this path relative to repo root. Use "." for entire project, "src" for src folder, or path to single file.'
    ),
    only_code_files: z.boolean().default(false).optional().describe(
      'Whether to restrict search to only code files (files with programming language extensions). Set to true for finding code symbols, false to search all files including configs, docs, etc.'
    ),
    case_sensitive: z.boolean().default(false).optional().describe(
      'Whether the pattern matching should be case sensitive (default: false for case-insensitive matching)'
    )
  });

  constructor(private readonly gitOperationsManager: GitOperationsManager) {
    super();
  }

  async execute(args: z.infer<typeof this.schema>): Promise<ToolResult> {
    const validationResult = this.schema.safeParse(args);
    if (!validationResult.success) {
      return toolError(`Invalid parameters: ${validationResult.error.issues.map(e => e.message).join(', ')}`);
    }

    try {
      const {
        pattern,
        lines_before = 0,
        lines_after = 0,
        include_files = '',
        exclude_files = '',
        search_path = '.',
        only_code_files = false,
        case_sensitive = false
      } = validationResult.data;

      const gitRepo = this.gitOperationsManager.getRepository();
      if (!gitRepo) {
        return toolError('Git repository not found');
      }

      // Step 1: Discover files to search
      const fileDiscoveryResult = await FileDiscoverer.discoverFiles(gitRepo, {
        searchPath: search_path,
        includePattern: include_files || undefined,
        excludePattern: exclude_files || undefined,
        respectGitignore: true,
        maxResults: 1000,
        timeoutMs: 30000
      });

      let filesToSearch = fileDiscoveryResult.files;

      // Step 2: Filter to code files if requested
      if (only_code_files) {
        filesToSearch = CodeFileDetector.filterCodeFiles(filesToSearch);
      }

      if (filesToSearch.length === 0) {
        return toolError('No files found matching the specified criteria');
      }

      // Step 3: Search for pattern in discovered files
      const matches = await this.searchInFiles({
        pattern,
        files: filesToSearch,
        gitRepo,
        linesBefore: lines_before,
        linesAfter: lines_after,
        caseSensitive: case_sensitive
      });

      if (matches.length === 0) {
        return toolError(`No matches found for pattern '${pattern}'`);
      }

      // Step 4: Format results as string
      let result = this.formatMatchesAsString(matches);

      if (fileDiscoveryResult.truncated) {
        result += `\n\n[Search was limited to first ${fileDiscoveryResult.files.length} files. Consider using more specific filters.]`;
      }

      return toolSuccess(result);

    } catch (error) {
      return toolError(`Pattern search failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Format matches as a readable string
   */
  private formatMatchesAsString(matches: SearchMatch[]): string {
    const lines: string[] = [];
    for (const match of matches) {
      lines.push(`=== ${match.file_path} ===`);
      lines.push(match.content);
      lines.push('');
    }
    return lines.join('\n').trim();
  }

  /**
   * Search for pattern in the specified files with context extraction
   */
  private async searchInFiles(options: {
    pattern: string;
    files: string[];
    gitRepo: Repository;
    linesBefore: number;
    linesAfter: number;
    caseSensitive: boolean;
  }): Promise<Array<{ file_path: string; content: string }>> {
    const { pattern, files, gitRepo, linesBefore, linesAfter, caseSensitive } = options;

    // Create regex with appropriate flags
    const regexFlags = `gm${caseSensitive ? '' : 'i'}s`; // global, multiline, case-insensitive (optional), dotall
    let regex: RegExp;

    try {
      regex = new RegExp(pattern, regexFlags);
    } catch (error) {
      throw new Error(`Invalid regex pattern: ${error instanceof Error ? error.message : String(error)}`);
    }

    const gitRootDirectory = gitRepo.rootUri.fsPath;
    const matches: Array<{ file_path: string; content: string }> = [];

    // Process files with reasonable limits
    const maxFilesToProcess = Math.min(files.length, 200); // Prevent excessive processing
    const filesToProcess = files.slice(0, maxFilesToProcess);

    for (const relativeFilePath of filesToProcess) {
      try {
        // Read file content
        const fileUri = vscode.Uri.file(`${gitRootDirectory}/${relativeFilePath}`);
        const fileContent = await vscode.workspace.fs.readFile(fileUri);
        const text = fileContent.toString();

        // Find matches with context
        const fileMatches = this.findMatchesWithContext(text, regex, linesBefore, linesAfter);

        if (fileMatches.length > 0) {
          // Group consecutive/overlapping matches
          const groupedContent = this.groupConsecutiveMatches(fileMatches);

          matches.push({
            file_path: relativeFilePath,
            content: groupedContent
          });
        }

      } catch (error) {
        // Skip files that can't be read (binary files, permission issues, etc.)
        continue;
      }
    }

    return matches;
  }

  /**
   * Find all pattern matches in text with context lines
   */
  private findMatchesWithContext(
    text: string,
    regex: RegExp,
    linesBefore: number,
    linesAfter: number
  ): Array<{ startLine: number; endLine: number; content: string }> {
    const lines = text.split('\n');
    const matches: Array<{ startLine: number; endLine: number; content: string }> = [];

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];

      // Reset regex state for each line
      regex.lastIndex = 0;

      if (regex.test(line)) {
        // Calculate context boundaries
        const contextStart = Math.max(0, lineIndex - linesBefore);
        const contextEnd = Math.min(lines.length - 1, lineIndex + linesAfter);

        // Extract lines with context
        const contextLines = lines.slice(contextStart, contextEnd + 1);

        // Format with line numbers
        const formattedLines = contextLines.map((contextLine, index) => {
          const actualLineNumber = contextStart + index + 1; // 1-based line numbers
          return `${actualLineNumber}: ${contextLine}`;
        });

        matches.push({
          startLine: contextStart + 1,
          endLine: contextEnd + 1,
          content: formattedLines.join('\n')
        });
      }
    }

    return matches;
  }

  /**
   * Group consecutive or overlapping matches to avoid duplication
   */
  private groupConsecutiveMatches(
    matches: Array<{ startLine: number; endLine: number; content: string }>
  ): string {
    if (matches.length === 0) return '';
    if (matches.length === 1) return matches[0].content;

    // Sort matches by start line
    const sortedMatches = matches.sort((a, b) => a.startLine - b.startLine);
    const grouped: string[] = [];

    let currentGroup = sortedMatches[0];

    for (let i = 1; i < sortedMatches.length; i++) {
      const nextMatch = sortedMatches[i];

      // Check if matches overlap or are consecutive (with small gap tolerance)
      if (nextMatch.startLine <= currentGroup.endLine + 2) {
        // Merge matches - extend the current group to include the next match
        const nextEndLine = Math.max(currentGroup.endLine, nextMatch.endLine);

        // Reconstruct content by taking the wider range
        const allLines = new Set<string>();
        currentGroup.content.split('\n').forEach(line => allLines.add(line));
        nextMatch.content.split('\n').forEach(line => allLines.add(line));

        // Sort lines by line number and reconstruct
        const sortedLines = Array.from(allLines).sort((a, b) => {
          const aNum = parseInt(a.split(':')[0]);
          const bNum = parseInt(b.split(':')[0]);
          return aNum - bNum;
        });

        currentGroup = {
          startLine: Math.min(currentGroup.startLine, nextMatch.startLine),
          endLine: nextEndLine,
          content: sortedLines.join('\n')
        };
      } else {
        // No overlap - add current group and start new one
        grouped.push(currentGroup.content);
        currentGroup = nextMatch;
      }
    }

    // Add the last group
    grouped.push(currentGroup.content);

    return grouped.join('\n\n');
  }
}