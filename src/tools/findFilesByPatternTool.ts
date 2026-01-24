import * as z from 'zod';
import * as vscode from 'vscode';
import { BaseTool } from './baseTool';
import { GitOperationsManager } from '../services/gitOperationsManager';
import { FileDiscoverer } from '../utils/fileDiscoverer';
import { ToolResult, toolSuccess, toolError } from '../types/toolResultTypes';
import type { ExecutionContext } from '../types/executionContext';

const FILE_SEARCH_TIMEOUT = 60_000; // 60 seconds for file search operations

/**
 * Tool that finds files matching glob patterns within a directory.
 * Automatically respects .gitignore rules and prevents directory traversal attacks.
 * Returns relative paths from project root.
 *
 * Supported glob patterns:
 * - * matches any number of characters (except path separators)
 * - ? matches exactly one character (except path separators)
 * - ** matches any number of directories recursively
 * - [abc] matches any character in the brackets
 * - {a,b,c} matches any of the patterns in the braces
 */

export class FindFilesByPatternTool extends BaseTool {
    name = 'find_files_by_pattern';
    description =
        'Find files matching glob patterns within a directory. Supports wildcards (*.js), recursive search (**/*.ts), multiple extensions (*.{js,ts}). Automatically respects .gitignore rules. Returns relative paths from project root.';

    schema = z.object({
        pattern: z
            .string()
            .min(1, 'Search pattern cannot be empty')
            .describe(
                'Glob pattern to match files: "*.js" (JS files), "**/*.test.ts" (test files recursively), "src/**/*.{js,ts}" (JS/TS in src directory), "README*" (README files), remember to add `**/` for recursive search in subdirectories.'
            ),
        search_directory: z
            .string()
            .default('.')
            .optional()
            .describe(
                'Directory to search within, relative to project root. Use "." for entire project, "src" for src folder, "tests" for test directory (default: ".")'
            ),
    });

    constructor(private readonly gitOperationsManager: GitOperationsManager) {
        super();
    }

    async execute(
        args: z.infer<typeof this.schema>,
        context: ExecutionContext
    ): Promise<ToolResult> {
        if (context.cancellationToken.isCancellationRequested) {
            throw new vscode.CancellationError();
        }

        const { pattern, search_directory: searchPath } = args;

        const gitRepo = this.gitOperationsManager.getRepository();
        if (!gitRepo) {
            return toolError('Git repository not found');
        }

        // FileDiscoverer handles timeout and cancellation internally
        const result = await FileDiscoverer.discoverFiles(gitRepo, {
            searchPath: searchPath || '.',
            includePattern: pattern,
            respectGitignore: true,
            timeoutMs: FILE_SEARCH_TIMEOUT,
            cancellationToken: context.cancellationToken,
        });

        if (result.files.length === 0) {
            // Distinguish between "no matches" vs "timed out before finding anything"
            if (result.truncated) {
                return toolError(
                    `Search timed out before finding any files matching pattern '${pattern}' in directory '${searchPath || '.'}'. The directory may be very large or the filesystem slow. Try a more specific search path.`
                );
            }
            return toolError(
                `No files found matching pattern '${pattern}' in directory '${searchPath || '.'}'. Did you forget to add '**/' for recursive search in subdirectories?`
            );
        }

        let output = result.files.join('\n');

        if (result.truncated) {
            output += `\n\n[Found ${result.totalFound} files, showing first ${result.files.length}. Consider using a more specific pattern.]`;
        }

        return toolSuccess(output);
    }
}
