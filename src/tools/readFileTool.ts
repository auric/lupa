import * as z from 'zod';
import * as vscode from 'vscode';
import * as path from 'path';
import { BaseTool } from './baseTool';
import { PathSanitizer } from '../utils/pathSanitizer';
import { TokenConstants } from '../models/tokenConstants';
import { GitOperationsManager } from '../services/gitOperationsManager';
import { withTimeout, isTimeoutError } from '../utils/asyncUtils';
import { ToolResult, toolSuccess, toolError } from '../types/toolResultTypes';
import { ExecutionContext } from '../types/executionContext';
import { OutputFormatter, FileContentOptions } from '../utils/outputFormatter';

const FILE_OPERATION_TIMEOUT = 15000; // 15 seconds for file operations

/**
 * Tool that reads file content with support for partial content reading.
 * Supports reading full files or specific line ranges for more focused context.
 */
export class ReadFileTool extends BaseTool {
    name = 'read_file';
    description = `Read the content of a file. Supports partial reading with start_line/end_line or start_line/line_count. Maximum ${TokenConstants.MAX_FILE_READ_LINES} lines per call - use pagination for larger files.`;

    schema = z
        .object({
            file_path: z
                .string()
                .min(1, 'File path cannot be empty')
                .describe(
                    'Relative path to the file to read (e.g., "src/components/Button.tsx")'
                ),
            start_line: z
                .number()
                .min(1)
                .optional()
                .describe(
                    'Starting line number (1-based). If provided alone, reads from this line to end of file (up to max lines limit)'
                ),
            end_line: z
                .number()
                .min(1)
                .optional()
                .describe(
                    'Ending line number (1-based, inclusive). Cannot be used together with line_count'
                ),
            line_count: z
                .number()
                .min(1)
                .optional()
                .describe(
                    'Number of lines to read from start_line. Cannot be used together with end_line'
                ),
        })
        .refine(
            (data) =>
                !(data.end_line !== undefined && data.line_count !== undefined),
            {
                message:
                    'Cannot specify both end_line and line_count. Use one or the other.',
            }
        );

    constructor(private readonly gitOperationsManager: GitOperationsManager) {
        super();
    }

    async execute(
        args: z.infer<typeof this.schema>,
        _context?: ExecutionContext
    ): Promise<ToolResult> {
        try {
            const { file_path, start_line, end_line, line_count } = args;

            const sanitizedPath = PathSanitizer.sanitizePath(file_path);

            const gitRootDirectory =
                this.gitOperationsManager.getRepository()?.rootUri.fsPath || '';
            if (!gitRootDirectory) {
                return toolError('Git repository not found');
            }

            const absoluteFilePath = path.join(gitRootDirectory, sanitizedPath);
            const fileUri = vscode.Uri.file(absoluteFilePath);

            try {
                await withTimeout(
                    Promise.resolve(vscode.workspace.fs.stat(fileUri)),
                    FILE_OPERATION_TIMEOUT,
                    `File stat for ${sanitizedPath}`
                );
            } catch (error) {
                if (isTimeoutError(error)) {
                    return toolError(
                        `File operation timed out: ${sanitizedPath}`
                    );
                }
                return toolError(`File not found: ${sanitizedPath}`);
            }

            let fileContent: string;
            try {
                const contentBytes = await withTimeout(
                    Promise.resolve(vscode.workspace.fs.readFile(fileUri)),
                    FILE_OPERATION_TIMEOUT,
                    `File read for ${sanitizedPath}`
                );
                fileContent = Buffer.from(contentBytes).toString('utf8');
            } catch (error) {
                if (isTimeoutError(error)) {
                    return toolError(`File read timed out: ${sanitizedPath}`);
                }
                const message =
                    error instanceof Error ? error.message : String(error);
                return toolError(
                    `Failed to read file ${sanitizedPath}: ${message}`
                );
            }

            const lines = fileContent.split('\n');
            const totalLines = lines.length;

            const readRange = this.calculateReadRange({
                startLine: start_line,
                endLine: end_line,
                lineCount: line_count,
                totalLines,
            });

            if (!readRange.success) {
                return toolError(readRange.error!);
            }

            const { actualStartLine, actualEndLine, wasTruncated } = readRange;
            const selectedLines = lines.slice(
                actualStartLine - 1,
                actualEndLine
            );

            const estimatedSize = selectedLines.join('\n').length + 200;
            if (estimatedSize > TokenConstants.MAX_TOOL_RESPONSE_CHARS) {
                return toolError(
                    `Selected content too large (${estimatedSize} characters, max: ${TokenConstants.MAX_TOOL_RESPONSE_CHARS}). ` +
                        `Reduce the range or use start_line=${actualStartLine}, line_count=${Math.floor(TokenConstants.MAX_TOOL_RESPONSE_CHARS / 100)} for smaller chunks.`
                );
            }

            const formattedContent = this.formatFileContentWithMetadata(
                sanitizedPath,
                selectedLines,
                actualStartLine,
                actualEndLine,
                totalLines,
                wasTruncated
            );

            return toolSuccess(formattedContent);
        } catch (error) {
            return toolError(
                `Unexpected error: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }

    private calculateReadRange(params: {
        startLine: number | undefined;
        endLine: number | undefined;
        lineCount: number | undefined;
        totalLines: number;
    }):
        | {
              success: true;
              actualStartLine: number;
              actualEndLine: number;
              wasTruncated: boolean;
          }
        | { success: false; error: string } {
        const { startLine, endLine, lineCount, totalLines } = params;
        const maxLines = TokenConstants.MAX_FILE_READ_LINES;

        // Case 1: No range parameters - read entire file (up to limit)
        if (
            startLine === undefined &&
            endLine === undefined &&
            lineCount === undefined
        ) {
            if (totalLines <= maxLines) {
                return {
                    success: true,
                    actualStartLine: 1,
                    actualEndLine: totalLines,
                    wasTruncated: false,
                };
            }
            return {
                success: true,
                actualStartLine: 1,
                actualEndLine: maxLines,
                wasTruncated: true,
            };
        }

        const actualStartLine = startLine ?? 1;

        if (actualStartLine > totalLines) {
            return {
                success: false,
                error: `Start line ${actualStartLine} exceeds file length (${totalLines} lines)`,
            };
        }

        // Case 2: end_line specified
        if (endLine !== undefined) {
            if (endLine < actualStartLine) {
                return {
                    success: false,
                    error: `end_line (${endLine}) must be >= start_line (${actualStartLine})`,
                };
            }

            const requestedLines = endLine - actualStartLine + 1;
            if (requestedLines > maxLines) {
                return {
                    success: false,
                    error:
                        `Requested ${requestedLines} lines exceeds maximum of ${maxLines}. ` +
                        `Split into multiple calls: first call start_line=${actualStartLine}, end_line=${actualStartLine + maxLines - 1}, ` +
                        `then start_line=${actualStartLine + maxLines}, end_line=${endLine}`,
                };
            }

            const clampedEndLine = Math.min(endLine, totalLines);
            return {
                success: true,
                actualStartLine,
                actualEndLine: clampedEndLine,
                wasTruncated: false,
            };
        }

        // Case 3: line_count specified
        if (lineCount !== undefined) {
            if (lineCount > maxLines) {
                return {
                    success: false,
                    error:
                        `Requested ${lineCount} lines exceeds maximum of ${maxLines}. ` +
                        `Use line_count=${maxLines} and make additional calls to read more.`,
                };
            }

            const potentialEndLine = actualStartLine + lineCount - 1;
            const clampedEndLine = Math.min(potentialEndLine, totalLines);
            return {
                success: true,
                actualStartLine,
                actualEndLine: clampedEndLine,
                wasTruncated: false,
            };
        }

        // Case 4: Only start_line specified - read to end of file (up to limit)
        const remainingLines = totalLines - actualStartLine + 1;
        if (remainingLines <= maxLines) {
            return {
                success: true,
                actualStartLine,
                actualEndLine: totalLines,
                wasTruncated: false,
            };
        }

        return {
            success: true,
            actualStartLine,
            actualEndLine: actualStartLine + maxLines - 1,
            wasTruncated: true,
        };
    }

    private formatFileContentWithMetadata(
        filePath: string,
        lines: string[],
        startLine: number,
        endLine: number,
        totalLines: number,
        wasTruncated: boolean
    ): string {
        const options: FileContentOptions = {
            filePath,
            lines,
            startLine,
            endLine,
            totalLines,
            wasTruncated,
        };
        return OutputFormatter.formatFileContent(options);
    }
}
