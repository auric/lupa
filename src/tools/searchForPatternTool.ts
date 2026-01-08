import * as z from 'zod';
import { BaseTool } from './baseTool';
import { GitOperationsManager } from '../services/gitOperationsManager';
import { RipgrepSearchService } from '../services/ripgrepSearchService';
import { ToolResult, toolSuccess, toolError } from '../types/toolResultTypes';
import { ExecutionContext } from '../types/executionContext';
import {
    isCancellationError,
    isTimeoutError,
    withCancellableTimeout,
} from '../utils/asyncUtils';

/** Maximum time for pattern search operations */
const PATTERN_SEARCH_TIMEOUT = 60_000; // 60 seconds

/**
 * High-performance tool for searching regex patterns in the codebase using ripgrep.
 * Supports context extraction, gitignore filtering, and code-file-only restrictions.
 *
 * Pattern Matching Logic:
 * - Uses ripgrep's Rust-based regex engine for fast searching
 * - Extracts configurable context lines before and after matches
 * - Groups consecutive matches intelligently
 *
 * File Selection Logic:
 * - Flexible glob pattern inclusion/exclusion
 * - Code-only filtering when only_code_files is enabled
 * - Full gitignore compliance (ripgrep respects .gitignore by default)
 */
export class SearchForPatternTool extends BaseTool {
    name = 'search_for_pattern';
    description = `Search for text patterns across the codebase using regex.

USE THIS for finding patterns like error handling, logging, similar code structures.
USE THIS when you don't know exact symbol names—pattern matching across files.
PREFER find_symbol when you know the symbol name—it's more precise.

Supports context lines, glob patterns for file filtering, and code-file-only mode.
Multiline matching is enabled—use \\n to match across lines.
Uses ripgrep for fast searching. Be careful with greedy quantifiers (use .*? instead of .*).`;

    schema = z.object({
        pattern: z
            .string()
            .min(1, 'Pattern cannot be empty')
            .describe(
                'Regular expression pattern to search for in file contents'
            ),
        lines_before: z
            .number()
            .int()
            .min(0)
            .max(20)
            .default(0)
            .optional()
            .describe(
                'Number of lines of context to include before each match (default: 0, max: 20)'
            ),
        lines_after: z
            .number()
            .int()
            .min(0)
            .max(20)
            .default(0)
            .optional()
            .describe(
                'Number of lines of context to include after each match (default: 0, max: 20)'
            ),
        include_files: z
            .string()
            .default('')
            .optional()
            .describe(
                'Optional glob pattern specifying files to include (e.g., "*.py", "src/**/*.ts"). If empty, all non-ignored files are included.'
            ),
        exclude_files: z
            .string()
            .default('')
            .optional()
            .describe(
                'Optional glob pattern specifying files to exclude (e.g., "*test*", "**/*_generated.py"). Takes precedence over include_files.'
            ),
        search_path: z
            .string()
            .default('.')
            .optional()
            .describe(
                'Only search within this path relative to repo root. Use "." for entire project, "src" for src folder, or path to single file.'
            ),
        only_code_files: z
            .boolean()
            .default(false)
            .optional()
            .describe(
                'Whether to restrict search to only code files (files with programming language extensions). Set to true for finding code symbols, false to search all files including configs, docs, etc.'
            ),
        case_sensitive: z
            .boolean()
            .default(false)
            .optional()
            .describe(
                'Whether the pattern matching should be case sensitive (default: false for case-insensitive matching)'
            ),
    });

    private readonly ripgrepService: RipgrepSearchService;

    constructor(private readonly gitOperationsManager: GitOperationsManager) {
        super();
        this.ripgrepService = new RipgrepSearchService();
    }

    async execute(
        args: z.infer<typeof this.schema>,
        context?: ExecutionContext
    ): Promise<ToolResult> {
        const validationResult = this.schema.safeParse(args);
        if (!validationResult.success) {
            return toolError(
                `Invalid parameters: ${validationResult.error.issues.map((e) => e.message).join(', ')}`
            );
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
                case_sensitive = false,
            } = validationResult.data;

            const gitRepo = this.gitOperationsManager.getRepository();
            if (!gitRepo) {
                return toolError('Git repository not found');
            }

            const gitRootDirectory = gitRepo.rootUri.fsPath;

            const results = await withCancellableTimeout(
                this.ripgrepService.search({
                    pattern,
                    cwd: gitRootDirectory,
                    searchPath: search_path !== '.' ? search_path : undefined,
                    linesBefore: lines_before,
                    linesAfter: lines_after,
                    caseSensitive: case_sensitive,
                    includeGlob: include_files || undefined,
                    excludeGlob: exclude_files || undefined,
                    codeFilesOnly: only_code_files,
                    multiline: true,
                    token: context?.cancellationToken,
                }),
                PATTERN_SEARCH_TIMEOUT,
                `Pattern search for '${pattern}'`,
                context?.cancellationToken
            );

            if (results.length === 0) {
                return toolError(`No matches found for pattern '${pattern}'`);
            }

            const formattedResult = this.ripgrepService.formatResults(results);
            return toolSuccess(formattedResult);
        } catch (error) {
            if (isCancellationError(error)) {
                throw error;
            }

            if (isTimeoutError(error)) {
                return toolError(
                    `Pattern search timed out. Try a more specific pattern or use search_path to limit the scope.`
                );
            }

            return toolError(
                `Pattern search failed: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }
}
