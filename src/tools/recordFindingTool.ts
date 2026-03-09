import * as z from 'zod';
import { BaseTool } from './baseTool';
import { toolSuccess, toolError } from '../types/toolResultTypes';
import type { ToolResult } from '../types/toolResultTypes';
import type { ExecutionContext } from '../types/executionContext';

export class RecordFindingTool extends BaseTool {
    name = 'record_finding';
    description =
        'Record a code review finding. Findings survive timeout/cancellation. ' +
        'CALL THIS for each confirmed issue after tool-backed verification and disproof attempt.';

    schema = z
        .object({
            severity: z
                .enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'])
                .describe('Finding severity'),
            title: z.string().describe('Brief finding title'),
            file: z.string().describe('Primary file path affected'),
            line: z.number().describe('Primary line number (1-indexed)'),
            description: z
                .string()
                .describe(
                    'Detailed description: what is wrong, what tool calls confirmed it, and what could go wrong'
                ),
            disproof_note: z
                .string()
                .describe(
                    'How you tried to disprove this finding and why it survived (e.g., "Checked callers with find_usages — all 3 callers pass unvalidated input")'
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

        const finding = store.record({
            agentId: context.currentAgentId ?? 'unknown',
            severity: args.severity,
            category: 'general',
            title: args.title,
            file: args.file,
            lineRange: [args.line, args.line],
            description: args.description,
            supportingToolCalls: [],
            disproof: {
                attempted: args.disproof_note.length > 0,
                method: args.disproof_note,
                result: args.disproof_note,
            },
            verifiableClaims: [],
        });

        return toolSuccess(
            `Finding recorded: [${finding.id}] ${finding.severity} — ${finding.title}`
        );
    }
}
