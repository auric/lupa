import * as z from 'zod';
import { BaseTool } from './baseTool';
import { toolSuccess, toolError } from '../types/toolResultTypes';
import type { ToolResult } from '../types/toolResultTypes';
import type { ExecutionContext } from '../types/executionContext';
import type { RecordedFinding } from '../types/findingTypes';

/**
 * Tool for reading findings recorded by other agents during this analysis.
 *
 * Enables cross-agent knowledge sharing in the RLM architecture:
 * - Subagents can see what other subagents have already found
 * - Prevents duplicate findings across parallel agents
 * - Root agent can query findings on-demand (not just at completion)
 *
 * Returns compact summaries to avoid context bloat.
 */
export class ListFindingsTool extends BaseTool {
    name = 'list_findings';
    description =
        'List findings recorded so far by all agents in this review. ' +
        'Use this to see what has already been found before recording a new finding — avoid duplicates. ' +
        'Returns compact summaries. Existing findings do NOT reduce your responsibility to investigate your assigned files thoroughly.';

    schema = z.object({
        file: z
            .string()
            .optional()
            .describe(
                'Filter by file path. Only return findings for this file.'
            ),
        severity: z
            .string()
            .optional()
            .describe('Filter by severity: CRITICAL, HIGH, MEDIUM, or LOW.'),
    });

    async execute(
        args: z.infer<typeof this.schema>,
        context: ExecutionContext
    ): Promise<ToolResult> {
        const store = context.findingStore;
        if (!store) {
            return toolError('Finding store not available in this context');
        }

        const query = {
            file: args.file,
            severity: args.severity?.toUpperCase() as
                | RecordedFinding['severity']
                | undefined,
            agentId: undefined,
        };

        const findings =
            args.file || args.severity ? store.query(query) : store.getAll();

        if (findings.length === 0) {
            const filterDesc = args.file
                ? ` for file "${args.file}"`
                : args.severity
                  ? ` with severity ${args.severity}`
                  : '';
            return toolSuccess(
                `No findings recorded yet${filterDesc}. This review is still in progress — investigate your assigned files independently.`
            );
        }

        const summaries = findings.map((f) => formatFindingSummary(f));
        const header = `${findings.length} finding(s) recorded so far:`;

        return toolSuccess(`${header}\n\n${summaries.join('\n\n')}`);
    }
}

function formatFindingSummary(f: RecordedFinding): string {
    return (
        `**${f.id}** [${f.severity}] ${f.title}\n` +
        `  File: ${f.file}:${f.lineRange[0]}\n` +
        `  Category: ${f.category} | Component: ${f.affectedComponent}\n` +
        `  Agent: ${f.agentId}`
    );
}
