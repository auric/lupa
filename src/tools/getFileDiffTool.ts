import * as z from 'zod';
import { BaseTool } from './baseTool';
import { ToolResult, toolSuccess, toolError } from '../types/toolResultTypes';
import { ExecutionContext } from '../types/executionContext';

/**
 * Tool that returns the actual diff content for one or more specific files.
 * Part of the RLM (Recursive Language Model) approach: instead of embedding
 * the full diff in the prompt, the LLM requests file diffs on demand.
 */
export class GetFileDiffTool extends BaseTool {
    name = 'get_file_diff';
    description =
        'Get the diff (code changes) for one or more specific files from the current PR. ' +
        'Returns the unified diff with added/removed/context lines and hunk headers. ' +
        'Use list_changed_files first to see what files changed, then this tool to examine specific files.';

    schema = z.object({
        file_paths: z
            .array(z.string().min(1))
            .min(1, 'At least one file path is required')
            .max(
                10,
                'Maximum 10 files per request to avoid overwhelming context'
            )
            .describe(
                'File path(s) to get the diff for. Must match paths from list_changed_files.'
            ),
        context_lines: z
            .boolean()
            .optional()
            .describe(
                'Include unchanged context lines around changes. Defaults to true.'
            ),
    });

    async execute(
        args: z.infer<typeof this.schema>,
        context: ExecutionContext
    ): Promise<ToolResult> {
        const parsedDiff = context.parsedDiff;
        if (!parsedDiff || parsedDiff.length === 0) {
            return toolError(
                'No diff data available. This tool is only available during PR/diff analysis.'
            );
        }

        const { file_paths, context_lines } = args;
        const includeContext = context_lines !== false;

        const results: string[] = [];
        const notFound: string[] = [];

        for (const rawPath of file_paths) {
            // Normalize backslashes (LLM may send Windows paths)
            const requestedPath = rawPath.replace(/\\/g, '/');

            // Exact match first, then match with path separator boundary
            // to prevent "Button.tsx" matching both "src/components/Button.tsx"
            // and "src/utils/Button.tsx".
            const matches = parsedDiff.filter(
                (f) =>
                    f.filePath === requestedPath ||
                    requestedPath === f.filePath ||
                    f.filePath.endsWith('/' + requestedPath) ||
                    requestedPath.endsWith('/' + f.filePath)
            );

            if (matches.length > 1) {
                notFound.push(
                    `${requestedPath} (ambiguous — matches: ${matches.map((m) => m.filePath).join(', ')})`
                );
                continue;
            }

            const fileDiff = matches[0];
            if (!fileDiff) {
                notFound.push(requestedPath);
                continue;
            }

            results.push(this.formatFileDiff(fileDiff, includeContext));
        }

        if (results.length === 0 && notFound.length > 0) {
            return toolError(
                `No matching files found for: ${notFound.join(', ')}. Use list_changed_files to see available file paths.`
            );
        }

        let output = results.join('\n');

        if (notFound.length > 0) {
            output += `\n\nNote: No diff found for: ${notFound.join(', ')}`;
        }

        return toolSuccess(output);
    }

    private formatFileDiff(
        fileDiff: {
            filePath: string;
            hunks: Array<{
                hunkHeader: string;
                parsedLines: Array<{
                    type: 'added' | 'removed' | 'context';
                    content: string;
                }>;
            }>;
            isNewFile: boolean;
            isDeletedFile: boolean;
        },
        includeContext: boolean
    ): string {
        const lines: string[] = [];
        const status = fileDiff.isNewFile
            ? ' (new file)'
            : fileDiff.isDeletedFile
              ? ' (deleted)'
              : '';

        lines.push(`=== ${fileDiff.filePath}${status} ===`);

        for (const hunk of fileDiff.hunks) {
            lines.push(hunk.hunkHeader);

            for (const parsedLine of hunk.parsedLines) {
                if (!includeContext && parsedLine.type === 'context') {
                    continue;
                }

                const prefix =
                    parsedLine.type === 'added'
                        ? '+'
                        : parsedLine.type === 'removed'
                          ? '-'
                          : ' ';
                lines.push(prefix + parsedLine.content);
            }

            lines.push('');
        }

        return lines.join('\n');
    }
}
