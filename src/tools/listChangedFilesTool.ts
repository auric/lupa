import * as z from 'zod';
import { BaseTool } from './baseTool';
import { ToolResult, toolSuccess, toolError } from '../types/toolResultTypes';
import { ExecutionContext } from '../types/executionContext';

/**
 * Tool that lists all files changed in the current PR/diff with metadata.
 * Part of the RLM (Recursive Language Model) approach: the LLM receives
 * only metadata about the diff, then uses tools to access actual content on demand.
 */
export class ListChangedFilesTool extends BaseTool {
    name = 'list_changed_files';
    description =
        'List all files changed in the current PR/diff with their status and statistics. ' +
        'Returns file paths, change type (added/modified/deleted), and line counts. ' +
        'Use this first to understand the scope of changes, then use get_file_diff to examine specific files.';

    schema = z
        .object({
            include_stats: z
                .boolean()
                .optional()
                .describe(
                    'Include per-file line statistics (lines added/removed). Defaults to true.'
                ),
        })
        .optional()
        .default({});

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

        const includeStats = args?.include_stats !== false;

        const lines: string[] = [];
        lines.push(`Changed files: ${parsedDiff.length}`);
        lines.push('');

        let totalAdded = 0;
        let totalRemoved = 0;

        for (const file of parsedDiff) {
            const status = file.isNewFile
                ? 'added'
                : file.isDeletedFile
                  ? 'deleted'
                  : 'modified';

            let linesAdded = 0;
            let linesRemoved = 0;
            let hunkCount = 0;

            for (const hunk of file.hunks) {
                hunkCount++;
                for (const line of hunk.parsedLines) {
                    if (line.type === 'added') {
                        linesAdded++;
                    }
                    if (line.type === 'removed') {
                        linesRemoved++;
                    }
                }
            }

            totalAdded += linesAdded;
            totalRemoved += linesRemoved;

            if (includeStats) {
                lines.push(
                    `- ${file.filePath} [${status}] (+${linesAdded} -${linesRemoved}, ${hunkCount} hunk${hunkCount !== 1 ? 's' : ''})`
                );
            } else {
                lines.push(`- ${file.filePath} [${status}]`);
            }
        }

        if (includeStats) {
            lines.push('');
            lines.push(`Total: +${totalAdded} -${totalRemoved}`);
        }

        return toolSuccess(lines.join('\n'));
    }
}
