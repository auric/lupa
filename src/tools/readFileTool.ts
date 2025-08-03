import { z } from 'zod';
import * as vscode from 'vscode';
import * as path from 'path';
import { BaseTool } from './baseTool';
import { PathSanitizer } from '../utils/pathSanitizer';
import { TokenConstants } from '../models/tokenConstants';
import { GitOperationsManager } from '../services/gitOperationsManager';
import { XmlUtils } from './xmlUtils';

/**
 * Tool that reads file content with support for partial content reading.
 * Supports reading full files or specific line ranges for more focused context.
 */
export class ReadFileTool extends BaseTool {
  name = 'read_file';
  description = 'Read the content of a file, optionally specifying a line range for partial reading. Useful for getting specific sections of code files.';

  schema = z.object({
    filePath: z.string().min(1, 'File path cannot be empty').describe('Relative path to the file to read (e.g., "src/components/Button.tsx")'),
    startLine: z.number().min(1).optional().describe('Optional starting line number (1-based) for partial reading'),
    lineCount: z.number().min(1).max(TokenConstants.MAX_FILE_READ_LINES).optional().describe(`Optional number of lines to read (max ${TokenConstants.MAX_FILE_READ_LINES}). If not specified, reads entire file or to end of file.`)
  });

  constructor(private readonly gitOperationsManager: GitOperationsManager) {
    super();
  }

  async execute(args: z.infer<typeof this.schema>): Promise<string[]> {
    try {
      const { filePath, startLine, lineCount } = args;

      // Sanitize the file path to prevent directory traversal attacks
      const sanitizedPath = PathSanitizer.sanitizePath(filePath);
      
      // Get git root directory
      const gitRootDirectory = this.gitOperationsManager.getRepository()?.rootUri.fsPath || '';
      if (!gitRootDirectory) {
        return [this.formatError('Git repository not found')];
      }

      // Construct absolute file path
      const absoluteFilePath = path.join(gitRootDirectory, sanitizedPath);
      const fileUri = vscode.Uri.file(absoluteFilePath);

      // Check if file exists
      try {
        await vscode.workspace.fs.stat(fileUri);
      } catch (error) {
        return [this.formatError(`File not found: ${sanitizedPath}`)];
      }

      // Read file content
      let fileContent: string;
      try {
        const contentBytes = await vscode.workspace.fs.readFile(fileUri);
        fileContent = Buffer.from(contentBytes).toString('utf8');
      } catch (error) {
        return [this.formatError(`Failed to read file ${sanitizedPath}: ${error instanceof Error ? error.message : String(error)}`)];
      }

      const lines = fileContent.split('\n');
      const totalLines = lines.length;

      // Handle full file reading
      if (!startLine && !lineCount) {
        if (fileContent.length > TokenConstants.MAX_TOOL_RESPONSE_CHARS) {
          return [this.formatError(
            `File too large (${fileContent.length} characters). ` +
            `Maximum allowed: ${TokenConstants.MAX_TOOL_RESPONSE_CHARS} characters. ` +
            `Please use startLine and lineCount parameters to read specific sections.`
          )];
        }
        return [this.formatFileContent(sanitizedPath, lines, 1)];
      }

      // Handle partial file reading
      const actualStartLine = startLine || 1;
      if (actualStartLine > totalLines) {
        return [this.formatError(`Start line ${actualStartLine} exceeds file length (${totalLines} lines)`)];
      }

      // Calculate end line
      const maxLinesToRead = Math.min(
        lineCount || TokenConstants.MAX_FILE_READ_LINES,
        TokenConstants.MAX_FILE_READ_LINES
      );
      const endLine = Math.min(actualStartLine + maxLinesToRead - 1, totalLines);

      // Extract lines (convert to 0-based indexing)
      const selectedLines = lines.slice(actualStartLine - 1, endLine);

      // Check response size before formatting
      const estimatedSize = selectedLines.join('\n').length + 500; // Add overhead for XML
      if (estimatedSize > TokenConstants.MAX_TOOL_RESPONSE_CHARS) {
        return [this.formatError(
          `Selected content too large (estimated ${estimatedSize} characters). ` +
          `Maximum allowed: ${TokenConstants.MAX_TOOL_RESPONSE_CHARS} characters. ` +
          `Please reduce lineCount parameter.`
        )];
      }

      return [this.formatFileContent(sanitizedPath, selectedLines, actualStartLine)];

    } catch (error) {
      const errorMessage = `Error reading file: ${error instanceof Error ? error.message : String(error)}`;
      return [this.formatError(errorMessage)];
    }
  }

  /**
   * Format file content as XML with line numbers in the format "lineNumber: content"
   * @param filePath File path for display
   * @param lines Array of lines to format
   * @param startLine Starting line number
   * @returns Formatted XML content string
   */
  private formatFileContent(filePath: string, lines: string[], startLine: number): string {
    const xmlParts = [
      '<file_content>',
      `  <file>${XmlUtils.escapeXml(filePath)}</file>`,
      '  <content>'
    ];

    // Add each line with proper line numbering using the format: lineNumber: content
    lines.forEach((line, index) => {
      const lineNumber = startLine + index;
      xmlParts.push(`${lineNumber}: ${XmlUtils.escapeXml(line)}`);
    });

    xmlParts.push('  </content>');
    xmlParts.push('</file_content>');

    return xmlParts.join('\n');
  }

  /**
   * Format an error result when file reading fails
   * @param error The error message
   * @returns Formatted XML string with error information
   */
  private formatError(error: string): string {
    const xmlParts = [
      '<file_content>',
      `  <error>${XmlUtils.escapeXml(error)}</error>`,
      '</file_content>'
    ];

    return xmlParts.join('\n');
  }
}