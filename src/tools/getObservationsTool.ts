import * as z from 'zod';
import { BaseTool } from './baseTool';
import { toolSuccess, toolError } from '../types/toolResultTypes';
import type { ToolResult } from '../types/toolResultTypes';
import type { ExecutionContext } from '../types/executionContext';
import { OBSERVATION_CATEGORIES } from '../types/observationTypes';

export class GetObservationsTool extends BaseTool {
    name = 'get_observations';
    description =
        'Read architectural observations left by other agents (or yourself). ' +
        'Call this to check for cross-concern notes before starting investigation, ' +
        'or during aggregation to see patterns across all agents. ' +
        'Returns all observations, optionally filtered by category or file.';

    schema = z
        .object({
            category: z
                .enum(OBSERVATION_CATEGORIES)
                .optional()
                .describe('Filter by observation category'),
            related_file: z
                .string()
                .optional()
                .describe(
                    'Filter observations related to a specific file path'
                ),
        })
        .strict();

    async execute(
        args: z.infer<typeof this.schema>,
        context: ExecutionContext
    ): Promise<ToolResult> {
        const store = context.observationStore;
        if (!store) {
            return toolError('Observation store not available in this context');
        }

        const observations = store.query({
            category: args.category,
            relatedFile: args.related_file,
            agentId: undefined,
        });

        if (observations.length === 0) {
            const filters = [];
            if (args.category) {
                filters.push(`category=${args.category}`);
            }
            if (args.related_file) {
                filters.push(`file=${args.related_file}`);
            }
            const filterText =
                filters.length > 0 ? ` (filters: ${filters.join(', ')})` : '';
            return toolSuccess(`No observations recorded yet${filterText}.`);
        }

        const formatted = observations.map((o) => {
            const files =
                o.relatedFiles.length > 0
                    ? ` | Files: ${o.relatedFiles.join(', ')}`
                    : '';
            return `[${o.id}] (${o.category}) by ${o.agentId}: ${o.title}${files}\n  ${o.content}`;
        });

        return toolSuccess(
            `${observations.length} observation(s):\n\n${formatted.join('\n\n')}`
        );
    }
}
