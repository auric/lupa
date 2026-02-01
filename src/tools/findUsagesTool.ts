import * as z from 'zod';
import * as vscode from 'vscode';
import * as path from 'path';
import { BaseTool } from './baseTool';
import { UsageFormatter } from './usageFormatter';
import { PathSanitizer } from '../utils/pathSanitizer';
import {
    withCancellableTimeout,
    isTimeoutError,
    rethrowIfCancellationOrTimeout,
} from '../utils/asyncUtils';
import { getErrorMessage } from '../utils/errorUtils';
import { ToolResult, toolSuccess, toolError } from '../types/toolResultTypes';
import { ExecutionContext } from '../types/executionContext';
import { GitOperationsManager } from '../services/gitOperationsManager';
import { Log } from '../services/loggingService';

const LSP_OPERATION_TIMEOUT = 60000; // 60 seconds for language server operations
const DEFINITION_CHECK_TIMEOUT = 10000; // 10 seconds per definition check (non-fatal)

/**
 * Tool that finds all usages of a code symbol using VS Code's reference provider.
 * Uses vscode.executeReferenceProvider to locate all references to a symbol.
 */
export class FindUsagesTool extends BaseTool {
    name = 'find_usages';
    description = `Find all places where a symbol is used/called across the codebase.

USE THIS to assess impact of changes—who calls this function?
USE THIS to verify all callers handle new behavior/parameters.
COMBINE with find_symbol: first understand the definition, then find who uses it.

Requires file_path where the symbol is defined as starting point.`;

    private readonly formatter = new UsageFormatter();

    constructor(private readonly gitOperationsManager: GitOperationsManager) {
        super();
    }

    schema = z.object({
        symbol_name: z
            .string()
            .min(1, 'Symbol name cannot be empty')
            .describe('The name of the symbol to find usages for'),
        file_path: z
            .string()
            .min(1, 'File path cannot be empty')
            .describe(
                'The file path where the symbol is defined (used as starting point for reference search)'
            ),
        should_include_declaration: z
            .boolean()
            .default(false)
            .optional()
            .describe(
                'Whether to include the symbol declaration in results (default: false)'
            ),
        context_line_count: z
            .number()
            .min(0)
            .max(10)
            .default(2)
            .optional()
            .describe(
                'Number of context lines to include around each usage (0-10, default: 2)'
            ),
    });

    async execute(
        args: z.infer<typeof this.schema>,
        context: ExecutionContext
    ): Promise<ToolResult> {
        if (context.cancellationToken.isCancellationRequested) {
            throw new vscode.CancellationError();
        }

        const {
            symbol_name,
            file_path,
            should_include_declaration,
            context_line_count,
        } = args;

        // Validate inputs before sanitization
        const trimmedSymbol = symbol_name.trim();
        const trimmedPath = file_path.trim();

        if (!trimmedSymbol) {
            return toolError('Symbol name cannot be empty');
        }

        if (!trimmedPath) {
            return toolError('File path cannot be empty');
        }

        // Sanitize input to prevent path traversal attacks
        const sanitizedSymbolName = trimmedSymbol;
        const sanitizedFilePath = PathSanitizer.sanitizePath(trimmedPath);

        // Get the git repository root for path resolution
        const gitRootDirectory =
            this.gitOperationsManager.getRepository()?.rootUri.fsPath;
        if (!gitRootDirectory) {
            return toolError('Git repository not found');
        }

        // Convert relative path to absolute path using git root
        const absolutePath = vscode.Uri.file(
            path.join(gitRootDirectory, sanitizedFilePath)
        );

        let document: vscode.TextDocument;
        try {
            document = await vscode.workspace.openTextDocument(absolutePath);
        } catch (error) {
            rethrowIfCancellationOrTimeout(error);
            return toolError(
                `Could not open file '${sanitizedFilePath}': ${getErrorMessage(error)}`
            );
        }

        // Find the symbol position in the document to use as starting point
        const symbolPosition = await this.findSymbolPosition(
            document,
            sanitizedSymbolName,
            context.cancellationToken
        );
        if (!symbolPosition) {
            return toolError(
                `No usages found for symbol '${sanitizedSymbolName}' in file '${sanitizedFilePath}'`
            );
        }

        // Use VS Code's reference provider to find all references (with timeout and cancellation)
        const references = await withCancellableTimeout(
            Promise.resolve(
                vscode.commands.executeCommand<vscode.Location[]>(
                    'vscode.executeReferenceProvider',
                    document.uri,
                    symbolPosition,
                    {
                        includeDeclaration: should_include_declaration || false,
                    }
                )
            ),
            LSP_OPERATION_TIMEOUT,
            `Reference search for ${sanitizedSymbolName}`,
            context.cancellationToken
        );

        // VS Code's reference provider may return undefined when cancelled internally.
        // Check cancellation token to properly propagate CancellationError instead of
        // returning "No usages found" which would hide the cancellation from callers.
        if (
            references === undefined &&
            context.cancellationToken.isCancellationRequested
        ) {
            throw new vscode.CancellationError();
        }

        if (!references || references.length === 0) {
            return toolError(
                `No usages found for symbol '${sanitizedSymbolName}' in file '${sanitizedFilePath}'`
            );
        }

        // Remove duplicates based on URI and range
        const uniqueReferences = this.deduplicateReferences(references);

        // Format each reference with context
        const formattedUsages: string[] = [];

        for (const reference of uniqueReferences) {
            if (context.cancellationToken.isCancellationRequested) {
                throw new vscode.CancellationError();
            }

            try {
                const refDocument = await vscode.workspace.openTextDocument(
                    reference.uri
                );
                const relativeFilePath = path
                    .relative(gitRootDirectory, reference.uri.fsPath)
                    .replace(/\\/g, '/');

                // Extract context lines around the reference
                const contextText = this.formatter.extractContextLines(
                    refDocument,
                    reference.range,
                    context_line_count || 2
                );

                const formattedUsage = this.formatter.formatUsage(
                    relativeFilePath,
                    sanitizedSymbolName,
                    reference.range,
                    contextText
                );

                formattedUsages.push(formattedUsage);
            } catch (error) {
                rethrowIfCancellationOrTimeout(error);
                const relativeFilePath = path
                    .relative(gitRootDirectory, reference.uri.fsPath)
                    .replace(/\\/g, '/');
                const errorUsage = this.formatter.formatErrorUsage(
                    relativeFilePath,
                    sanitizedSymbolName,
                    reference.range,
                    error
                );

                formattedUsages.push(errorUsage);
            }
        }

        return toolSuccess(formattedUsages.join('\n\n'));
    }

    /**
     * Find the index of a symbol as a whole word in a line.
     * Uses word boundaries that correctly handle symbols starting/ending with non-word characters.
     * @param line The line of text to search
     * @param symbolName The symbol name to find
     * @returns The index of the symbol in the line, or -1 if not found
     */
    private findWholeWordIndex(line: string, symbolName: string): number {
        const escaped = symbolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const firstChar = symbolName[0] ?? '';
        const lastChar = symbolName[symbolName.length - 1] ?? '';
        const isFirstWordChar = /\w/.test(firstChar);
        const isLastWordChar = /\w/.test(lastChar);

        const prefix = isFirstWordChar ? '\\b' : '(?<![\\w])';
        const suffix = isLastWordChar ? '\\b' : '(?![\\w])';

        const regex = new RegExp(`${prefix}${escaped}${suffix}`);
        const match = regex.exec(line);
        return match ? match.index : -1;
    }

    /**
     * Find the position of a symbol within a document
     * @param document The VS Code text document
     * @param symbolName The name of the symbol to find
     * @param token Optional cancellation token
     * @returns The position of the symbol, or null if not found
     */
    private async findSymbolPosition(
        document: vscode.TextDocument,
        symbolName: string,
        token: vscode.CancellationToken
    ): Promise<vscode.Position | null> {
        const text = document.getText();
        const lines = text.split('\n');

        // Look for the symbol in the document
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
            if (token.isCancellationRequested) {
                throw new vscode.CancellationError();
            }

            const line = lines[lineIndex];
            if (!line) {
                continue;
            }
            const symbolIndex = this.findWholeWordIndex(line, symbolName);

            if (symbolIndex !== -1) {
                const position = new vscode.Position(lineIndex, symbolIndex);

                // Verify this is actually a symbol definition by checking if definition provider returns this location
                try {
                    const definitions = await withCancellableTimeout(
                        Promise.resolve(
                            vscode.commands.executeCommand<vscode.Location[]>(
                                'vscode.executeDefinitionProvider',
                                document.uri,
                                position
                            )
                        ),
                        DEFINITION_CHECK_TIMEOUT,
                        `Definition check for ${symbolName}`,
                        token
                    );

                    // If we get back the same location, this is likely the definition
                    if (
                        definitions &&
                        definitions.some(
                            (def) =>
                                def.uri.toString() ===
                                    document.uri.toString() &&
                                def.range.contains(position)
                        )
                    ) {
                        return position;
                    }
                } catch (error) {
                    // Log timeout but continue searching (non-fatal for definition check)
                    if (isTimeoutError(error)) {
                        Log.debug(
                            `Definition check timed out for ${symbolName} at line ${lineIndex + 1}, continuing search`
                        );
                        continue;
                    }
                    // Other errors should bubble up
                    throw error;
                }
            }
        }

        // If no definition found, return the first occurrence as fallback
        for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
            if (token.isCancellationRequested) {
                throw new vscode.CancellationError();
            }

            const line = lines[lineIndex];
            if (!line) {
                continue;
            }
            const symbolIndex = this.findWholeWordIndex(line, symbolName);

            if (symbolIndex !== -1) {
                return new vscode.Position(lineIndex, symbolIndex);
            }
        }

        return null;
    }

    /**
     * Remove duplicate references based on URI and range
     * @param references Array of VS Code Location objects
     * @returns Deduplicated array of references
     */
    private deduplicateReferences(
        references: vscode.Location[]
    ): vscode.Location[] {
        return references.filter((ref, index, arr) => {
            return (
                arr.findIndex(
                    (r) =>
                        r.uri.toString() === ref.uri.toString() &&
                        r.range.start.line === ref.range.start.line &&
                        r.range.start.character === ref.range.start.character &&
                        r.range.end.line === ref.range.end.line &&
                        r.range.end.character === ref.range.end.character
                ) === index
            );
        });
    }
}
