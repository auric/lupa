import * as z from 'zod';
import * as path from 'path';
import * as vscode from 'vscode';
import { BaseTool } from './baseTool';
import { GitOperationsManager } from '../services/gitOperationsManager';
import { PathSanitizer } from '../utils/pathSanitizer';
import { SymbolExtractor } from '../utils/symbolExtractor';
import { SymbolFormatter } from '../utils/symbolFormatter';
import { OutputFormatter } from '../utils/outputFormatter';
import {
    withCancellableTimeout,
    isTimeoutError,
    isCancellationError,
} from '../utils/asyncUtils';
import { ToolResult, toolSuccess, toolError } from '../types/toolResultTypes';
import { ExecutionContext } from '../types/executionContext';

const LSP_OPERATION_TIMEOUT = 30_000; // 30 seconds for language server operations

/**
 * Enhanced tool that provides a configurable overview of symbols in a file or directory.
 * Supports hierarchy control, symbol filtering, body inclusion, and LLM-optimized output formatting.
 * Uses lineNumber: symbolName format for precise code references.
 * Respects .gitignore and other ignore files, prevents directory traversal attacks.
 */
export class GetSymbolsOverviewTool extends BaseTool {
    name = 'get_symbols_overview';
    description = `Get a configurable overview of symbols (classes, functions, methods, etc.) in a file or directory.
Supports hierarchy control, symbol filtering, and body inclusion for detailed code analysis.
Output format: "lineNumber: symbolName (symbolType)" with optional indentation for hierarchy.
Respects .gitignore files and provides LLM-optimized formatting for code review.`;

    schema = z.object({
        path: z
            .string()
            .min(1, 'Path cannot be empty')
            .describe(
                'The relative path to the file or directory to get symbols overview for (e.g., "src", "src/services", "src/tools/findSymbolTool.ts")'
            ),
        max_depth: z
            .number()
            .int()
            .min(-1)
            .default(0)
            .optional()
            .describe(
                'Symbol hierarchy depth: 0=top-level only, 1=include direct children, -1=unlimited depth'
            ),
        include_body: z
            .boolean()
            .default(false)
            .optional()
            .describe(
                'Include symbol source code for implementation details. Warning: significantly increases response size.'
            ),
        include_kinds: z
            .array(z.string())
            .optional()
            .describe(
                'Include only these symbol types: "class", "function", "method", "interface", "property", "variable", "constant", "enum"'
            ),
        exclude_kinds: z
            .array(z.string())
            .optional()
            .describe(
                'Exclude these symbol types. Takes precedence over include_kinds.'
            ),
        max_symbols: z
            .number()
            .int()
            .min(1)
            .default(100)
            .optional()
            .describe(
                'Maximum number of symbols to return to prevent overwhelming output'
            ),
        show_hierarchy: z
            .boolean()
            .default(true)
            .optional()
            .describe('Show indented hierarchy structure vs flat list'),
    });

    constructor(
        private readonly gitOperationsManager: GitOperationsManager,
        private readonly symbolExtractor: SymbolExtractor
    ) {
        super();
    }

    async execute(
        args: z.infer<typeof this.schema>,
        context?: ExecutionContext
    ): Promise<ToolResult> {
        const validationResult = this.schema.safeParse(args);
        if (!validationResult.success) {
            return toolError(
                validationResult.error.issues.map((e) => e.message).join(', ')
            );
        }

        try {
            const {
                path: relativePath,
                max_depth: maxDepth,
                include_body: includeBody,
                include_kinds: includeKindsStrings,
                exclude_kinds: excludeKindsStrings,
                max_symbols: maxSymbols,
                show_hierarchy: showHierarchy,
            } = validationResult.data;

            // Convert string kinds to numbers
            const includeKinds = includeKindsStrings
                ?.map((kind) => SymbolFormatter.convertKindStringToNumber(kind))
                .filter((k) => k !== undefined) as number[] | undefined;
            const excludeKinds = excludeKindsStrings
                ?.map((kind) => SymbolFormatter.convertKindStringToNumber(kind))
                .filter((k) => k !== undefined) as number[] | undefined;

            // Sanitize the relative path to prevent directory traversal attacks
            const sanitizedPath = PathSanitizer.sanitizePath(relativePath);

            const effectiveMaxSymbols = maxSymbols || 100;

            // Get symbols overview using enhanced utilities (with cancellable timeout)
            const token = context?.cancellationToken;
            const { content, symbolCount, truncated } =
                await withCancellableTimeout(
                    this.getEnhancedSymbolsOverview(
                        sanitizedPath,
                        {
                            maxDepth: maxDepth || 0,
                            showHierarchy: showHierarchy ?? true,
                            includeBody: includeBody || false,
                            maxSymbols: effectiveMaxSymbols,
                            includeKinds,
                            excludeKinds,
                        },
                        token
                    ),
                    LSP_OPERATION_TIMEOUT,
                    `Symbol overview for ${sanitizedPath}`,
                    token
                );

            if (symbolCount === 0) {
                return toolError(`No symbols found in '${sanitizedPath}'`);
            }

            let result = content;
            if (truncated) {
                result += `\n\n[Output limited to ${effectiveMaxSymbols} symbols. Use more specific path or filters to see more.]`;
            }

            return toolSuccess(result);
        } catch (error) {
            if (isCancellationError(error)) {
                throw error; // Re-throw cancellation to stop tool execution
            }
            if (isTimeoutError(error)) {
                return toolError(
                    `Symbol extraction timed out. Try a specific file path instead of a directory, or use filters.`
                );
            }
            const message =
                error instanceof Error ? error.message : String(error);
            return toolError(`Failed to get symbols overview: ${message}`);
        }
    }

    /**
     * Get enhanced symbols overview for the specified path using new utilities
     */
    private async getEnhancedSymbolsOverview(
        relativePath: string,
        options: {
            maxDepth: number;
            showHierarchy: boolean;
            includeBody: boolean;
            maxSymbols: number;
            includeKinds?: number[];
            excludeKinds?: number[];
        },
        token?: vscode.CancellationToken
    ): Promise<{ content: string; symbolCount: number; truncated: boolean }> {
        const gitRootDirectory = this.symbolExtractor.getGitRootPath();
        if (!gitRootDirectory) {
            throw new Error('Git repository not found');
        }

        const targetPath = path.join(gitRootDirectory, relativePath);
        const stat = await this.symbolExtractor.getPathStat(targetPath);

        if (!stat) {
            throw new Error(`Path '${relativePath}' not found`);
        }

        const allResults: string[] = [];
        let totalSymbolCount = 0;
        let anyTruncated = false;

        if (stat.type === vscode.FileType.File) {
            // Single file - get its symbols with enhanced formatting
            const fileUri = vscode.Uri.file(targetPath);
            const { symbols, document } =
                await this.symbolExtractor.extractSymbolsWithContext(
                    fileUri,
                    token
                );

            const firstSymbol = symbols[0];
            if (
                symbols.length > 0 &&
                firstSymbol &&
                'children' in firstSymbol
            ) {
                const result = SymbolFormatter.formatSymbolsWithHierarchy(
                    symbols as vscode.DocumentSymbol[],
                    document,
                    options
                );

                if (result.formatted) {
                    allResults.push(
                        OutputFormatter.formatSymbolOverview({
                            filePath: relativePath,
                            content: result.formatted,
                        })
                    );
                    totalSymbolCount += result.symbolCount;
                    anyTruncated = anyTruncated || result.truncated;
                }
            }
        } else if (stat.type === vscode.FileType.Directory) {
            // Directory - get symbols from all files using SymbolExtractor
            // Uses LSP_OPERATION_TIMEOUT since outer withTimeout already wraps this
            const {
                results: directoryResults,
                truncated: dirTruncated,
                timedOutFiles,
            } = await this.symbolExtractor.getDirectorySymbols(
                targetPath,
                relativePath,
                { timeoutMs: LSP_OPERATION_TIMEOUT, token }
            );

            if (dirTruncated || timedOutFiles > 0) {
                anyTruncated = true;
            }

            // Sort results by file path for consistent output
            const sortedResults = directoryResults.sort((a, b) =>
                a.filePath.localeCompare(b.filePath)
            );

            for (const { filePath, symbols } of sortedResults) {
                if (symbols.length === 0) {
                    continue;
                }
                if (totalSymbolCount >= options.maxSymbols) {
                    anyTruncated = true;
                    break;
                }

                // Get document for body extraction if needed
                const fullPath = path.join(gitRootDirectory, filePath);
                const fileUri = vscode.Uri.file(fullPath);
                const document = options.includeBody
                    ? await this.symbolExtractor.getTextDocument(fileUri)
                    : undefined;

                // Only process DocumentSymbols for hierarchy (SymbolInformation doesn't have hierarchy)
                const firstSymbol = symbols[0];
                if (
                    symbols.length > 0 &&
                    firstSymbol &&
                    'children' in firstSymbol
                ) {
                    const remainingSymbols =
                        options.maxSymbols - totalSymbolCount;
                    const result = SymbolFormatter.formatSymbolsWithHierarchy(
                        symbols as vscode.DocumentSymbol[],
                        document,
                        { ...options, maxSymbols: remainingSymbols }
                    );

                    if (result.formatted) {
                        allResults.push(
                            OutputFormatter.formatSymbolOverview({
                                filePath,
                                content: result.formatted,
                            })
                        );
                        totalSymbolCount += result.symbolCount;
                        anyTruncated = anyTruncated || result.truncated;
                    }
                }
            }
        }

        return {
            content: allResults.join('\n\n'),
            symbolCount: totalSymbolCount,
            truncated: anyTruncated,
        };
    }
}
