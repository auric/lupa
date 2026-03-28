import * as z from 'zod';
import { BaseTool } from './baseTool';
import { toolSuccess, toolError } from '../types/toolResultTypes';
import type { ToolResult } from '../types/toolResultTypes';
import type { ExecutionContext } from '../types/executionContext';
import { OBSERVATION_CATEGORIES } from '../types/observationTypes';

export class NoteObservationTool extends BaseTool {
    name = 'note_observation';
    description =
        'Record an architectural observation or cross-concern note for other agents to see. ' +
        'Use this when you notice something outside your direct investigation scope that may be relevant ' +
        'to other agents or the final review synthesis. Unlike record_finding, observations are lightweight ' +
        'notes — not verified bugs. They help detect cross-cutting architectural issues that individual agents might miss.';

    schema = z
        .object({
            category: z
                .enum(OBSERVATION_CATEGORIES)
                .describe(
                    'Category: dependency (cross-file/module dependency), pattern (recurring code pattern), ' +
                        'invariant (assumed invariant that could break), concern (potential issue outside your scope), ' +
                        'convention (coding convention observed)'
                ),
            title: z
                .string()
                .describe('Brief title for the observation (1 line)'),
            content: z
                .string()
                .describe(
                    'The observation details — what you noticed and why it might matter for other agents or the final review'
                ),
            related_files: z
                .array(z.string())
                .optional()
                .describe('File paths related to this observation'),
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

        const observation = store.add({
            agentId: context.currentAgentId ?? 'unknown',
            category: args.category,
            title: args.title,
            content: args.content,
            relatedFiles: args.related_files ?? [],
        });

        return toolSuccess(
            `Observation ${observation.id} recorded: "${observation.title}" [${observation.category}]. ` +
                `Total observations: ${store.size}. Other agents can see this via get_observations.`
        );
    }
}
