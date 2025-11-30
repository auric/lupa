import { z } from 'zod';
import * as vscode from 'vscode';
import * as path from 'path';
import { BaseTool } from './baseTool';
import { PathSanitizer } from '../utils/pathSanitizer';
import { TokenConstants } from '../models/tokenConstants';
import { GitOperationsManager } from '../services/gitOperationsManager';
import { ToolResult, toolSuccess, toolError } from '../types/toolResultTypes';
import { OutputFormatter } from '../utils/outputFormatter';

/**
 * Tool that reads file content with support for partial content reading.
 * Supports reading full files or specific line ranges for more focused context.
 */
export class ReadFileTool extends BaseTool {
  name = 'read_file';
  description = 'Read the content of a file, optionally specifying a line range for partial reading. Useful for getting specific sections of code files.';

  schema = z.object({
    file_path: z.string().min(1, 'File path cannot be empty')
      .describe('Relative path to the file to read (e.g., "src/components/Button.tsx")'),
    start_line: z.number().min(1).optional()
      .describe('Optional starting line number (1-based) for partial reading'),
    line_count: z.number().min(1).max(TokenConstants.MAX_FILE_READ_LINES).optional()
      .describe(`Optional number of lines to read (max ${TokenConstants.MAX_FILE_READ_LINES}). If not specified, reads entire file or to end of file.`)
  });

  constructor(private readonly gitOperationsManager: GitOperationsManager) {
    super();
  }

  async execute(args: z.infer<typeof this.schema>): Promise<ToolResult<string>> {
    try {
      const { file_path, start_line, line_count } = args;

      // Sanitize the file path to prevent directory traversal attacks
      const sanitizedPath = PathSanitizer.sanitizePath(file_path);

      // Get git root directory
      const gitRootDirectory = this.gitOperationsManager.getRepository()?.rootUri.fsPath || '';
      if (!gitRootDirectory) {
        return toolError('Git repository not found');
      }

      // Construct absolute file path
      const absoluteFilePath = path.join(gitRootDirectory, sanitizedPath);
      const fileUri = vscode.Uri.file(absoluteFilePath);

      // Check if file exists
      try {
        await vscode.workspace.fs.stat(fileUri);
      } catch (error) {
        return toolError(`File not found: ${sanitizedPath}`);
      }

      // Read file content
      let fileContent: string;
      try {
        const contentBytes = await vscode.workspace.fs.readFile(fileUri);
        fileContent = Buffer.from(contentBytes).toString('utf8');
      } catch (error) {
        return toolError(`Failed to read file ${sanitizedPath}: ${error instanceof Error ? error.message : String(error)}`);
      }

      const lines = fileContent.split('\n');
      const totalLines = lines.length;

      // Handle full file reading
      if (!start_line && !line_count) {
        if (fileContent.length > TokenConstants.MAX_TOOL_RESPONSE_CHARS) {
          return toolError(
            `File too large (${fileContent.length} characters). ` +
            `Maximum allowed: ${TokenConstants.MAX_TOOL_RESPONSE_CHARS} characters. ` +
            `Please use start_line and line_count parameters to read specific sections.`
          );
        }
        return toolSuccess(this.formatFileContent(sanitizedPath, lines, 1));
      }

      // Handle partial file reading
      const actualStartLine = start_line || 1;
      if (actualStartLine > totalLines) {
        return toolError(`Start line ${actualStartLine} exceeds file length (${totalLines} lines)`);
      }

      // Calculate end line
      const maxLinesToRead = Math.min(
        line_count || TokenConstants.MAX_FILE_READ_LINES,
        TokenConstants.MAX_FILE_READ_LINES
      );
      const endLine = Math.min(actualStartLine + maxLinesToRead - 1, totalLines);

      // Extract lines (convert to 0-based indexing)
      const selectedLines = lines.slice(actualStartLine - 1, endLine);

      // Check response size before formatting
      const estimatedSize = selectedLines.join('\n').length + 100;
      if (estimatedSize > TokenConstants.MAX_TOOL_RESPONSE_CHARS) {
        return toolError(
          `Selected content too large (estimated ${estimatedSize} characters). ` +
          `Maximum allowed: ${TokenConstants.MAX_TOOL_RESPONSE_CHARS} characters. ` +
          `Please reduce line_count parameter.`
        );
      }

      return toolSuccess(this.formatFileContent(sanitizedPath, selectedLines, actualStartLine));

    } catch (error) {
      return toolError(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Format file content with header and line numbers
   * @param filePath File path for display
   * @param lines Array of lines to format
   * @param startLine Starting line number
   * @returns Formatted string with file header and numbered lines
   */
  private formatFileContent(filePath: string, lines: string[], startLine: number): string {
    return OutputFormatter.formatFileContent({ filePath, lines, startLine });
  }
}