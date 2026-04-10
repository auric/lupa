import * as z from 'zod';
import { BaseTool } from './baseTool';
import { toolSuccess, toolError } from '../types/toolResultTypes';
import type { ToolResult } from '../types/toolResultTypes';
import type { ExecutionContext } from '../types/executionContext';

export class RetractFindingTool extends BaseTool {
    name = 'retract_finding';
    description =
        'Remove a previously recorded finding that you determined was incorrect after further investigation. ' +
        'Provide the finding ID and a brief reason for retraction. ' +
        'This is preferred over leaving wrong findings in the store.';

    schema = z
        .object({
            finding_id: z
                .string()
                .describe('ID of the finding to retract (e.g., "finding-3")'),
            reason: z
                .string()
                .describe(
                    'Brief explanation of why this finding is being retracted'
                ),
        })
        .strict();

    async execute(
        args: z.infer<typeof this.schema>,
        context: ExecutionContext
    ): Promise<ToolResult> {
        const store = context.findingStore;
        if (!store) {
            return toolError('Finding store not available in this context');
        }

        const existing = store.getById(args.finding_id);
        if (!existing) {
            return toolError(
                `Finding "${args.finding_id}" not found. Check finding IDs from your previous record_finding calls.`
            );
        }

        store.remove(args.finding_id);

        // Revert hypothesis status if this finding confirmed one
        if (context.reasoningChain) {
            const confirmed = context.reasoningChain
                .getAllHypotheses()
                .filter(
                    (h) =>
                        h.status === 'confirmed' &&
                        h.confirmedByFindingId === args.finding_id
                );
            for (const h of confirmed) {
                context.reasoningChain.revertToInvestigating(
                    h.id,
                    'Finding retracted'
                );
            }
        }

        return toolSuccess(
            `Retracted finding "${args.finding_id}" (${existing.title}). Reason: ${args.reason}. Remaining findings: ${store.size}.`
        );
    }
}
