import * as z from 'zod';
import * as path from 'path';
import { BaseTool } from './baseTool';
import { ToolResult, toolSuccess, toolError } from '../types/toolResultTypes';
import { ExecutionContext } from '../types/executionContext';
import { TokenConstants } from '../models/tokenConstants';
import { coerceToStringArray } from './schemaHelpers';

/**
 * Tool that returns the actual diff content for one or more specific files.
 * Part of the RLM (Recursive Language Model) approach: instead of embedding
 * the full diff in the prompt, the LLM requests file diffs on demand.
 */
export class GetFileDiffTool extends BaseTool {
    name = 'get_file_diff';
    description =
        'Get the diff (code changes) for specific files from the current PR. ' +
        'Pass ALL file paths you need in a SINGLE call via the file_paths array — do NOT call this tool once per file. ' +
        'Returns the unified diff with added/removed/context lines and hunk headers. ' +
        'Check <diff_metadata> in your conversation to see what files changed, then use this tool to examine specific files.';

    schema = z.object({
        file_paths: z
            .preprocess(
                coerceToStringArray,
                z
                    .array(z.string().trim().min(1))
                    .min(1, 'At least one file path is required')
                    .max(
                        10,
                        'Maximum 10 files per request to avoid overwhelming context'
                    )
            )
            .describe(
                'Array of file paths to fetch diffs for IN ONE CALL (up to 10). ' +
                    'Pass ALL paths you need at once — do NOT make separate calls per file. ' +
                    'Paths must match those shown in <diff_metadata>.'
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

        const results: Array<{ path: string; text: string }> = [];
        const notFound: string[] = [];

        for (const rawPath of file_paths) {
            // Normalize backslashes, strip leading './' and '/', resolve '..' segments
            const normalized = rawPath
                .trim()
                .replace(/\\/g, '/')
                .replace(/^\/+/, '')
                .replace(/^\.\//, '');
            const requestedPath = path.posix.normalize(normalized);

            if (requestedPath === '..' || requestedPath.startsWith('../')) {
                notFound.push(`${rawPath.trim()} (path traversal not allowed)`);
                continue;
            }

            // Exact match first, then suffix match with path separator boundary.
            // Prioritize exact match to avoid false ambiguity when "Button.tsx"
            // exists alongside "src/components/Button.tsx".
            const exactMatch = parsedDiff.find(
                (f) => f.filePath === requestedPath
            );
            let fileDiff = exactMatch;

            if (!fileDiff) {
                const suffixMatches = parsedDiff.filter((f) =>
                    f.filePath.endsWith('/' + requestedPath)
                );

                if (suffixMatches.length > 1) {
                    notFound.push(
                        `${requestedPath} (ambiguous — matches: ${suffixMatches.map((m) => m.filePath).join(', ')})`
                    );
                    continue;
                }

                fileDiff = suffixMatches[0];
            }
            if (!fileDiff) {
                notFound.push(requestedPath);
                continue;
            }

            results.push({
                path: rawPath.trim(),
                text: this.formatFileDiff(fileDiff, includeContext),
            });
        }

        if (results.length === 0 && notFound.length > 0) {
            return toolError(
                `No matching files found for: ${notFound.join(', ')}. Check <diff_metadata> in the conversation for available file paths.`
            );
        }

        // Build output incrementally with size guard to avoid ToolExecutor
        // rejecting the entire response when combined diffs exceed the limit.
        const maxChars = TokenConstants.MAX_TOOL_RESPONSE_CHARS;
        let output = '';
        const omitted: string[] = [];

        for (let i = 0; i < results.length; i++) {
            const { path: filePath, text: candidate } = results[i]!;
            if (candidate.length > maxChars && output.length === 0) {
                // Single diff exceeds limit — return truncated with guidance
                const truncated = candidate.slice(0, maxChars - 200);
                return toolSuccess(
                    truncated +
                        `\n\n[TRUNCATED — diff for ${filePath} exceeds size limit. ` +
                        'Try with context_lines: false or request fewer files.]'
                );
            }
            if (
                output.length + candidate.length + 1 > maxChars &&
                output.length > 0
            ) {
                // Remaining files won't fit — collect their paths for the note
                for (let j = i; j < results.length; j++) {
                    omitted.push(results[j]!.path);
                }
                break;
            }
            output += (output.length > 0 ? '\n' : '') + candidate;
        }

        if (omitted.length > 0) {
            const omittedNote = `\n\nNote: ${omitted.length} file(s) omitted due to response size limit — request them in a separate call: ${omitted.join(', ')}`;
            if (output.length + omittedNote.length <= maxChars) {
                output += omittedNote;
            } else {
                const shortNote = `\n\nNote: ${omitted.length} file(s) omitted due to response size limit.`;
                if (output.length + shortNote.length <= maxChars) {
                    output += shortNote;
                }
            }
        }

        if (notFound.length > 0) {
            const notFoundNote = `\n\nNote: No diff found for: ${notFound.join(', ')}`;
            if (output.length + notFoundNote.length <= maxChars) {
                output += notFoundNote;
            }
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
