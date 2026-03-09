import * as z from 'zod';
import { BaseTool } from './baseTool';
import { toolSuccess, toolError } from '../types/toolResultTypes';
import type { ToolResult } from '../types/toolResultTypes';
import type { ExecutionContext } from '../types/executionContext';

export class RecordFindingTool extends BaseTool {
    name = 'record_finding';
    description =
        'Record a structured review finding to the finding store. Findings are committed incrementally as you discover them, surviving timeout/cancellation. ' +
        'Each finding requires evidence (supporting tool calls) and a disproof attempt. ' +
        'Verifiable claims enable optional LSP validation for compiler-grade fact-checking.';

    schema = z
        .object({
            severity: z
                .enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'])
                .describe('Finding severity'),
            category: z
                .string()
                .describe(
                    'Finding category (e.g., "error-handling", "type-safety", "security")'
                ),
            title: z.string().describe('Brief finding title'),
            file: z.string().describe('Primary file path affected'),
            line_range: z
                .tuple([z.number(), z.number()])
                .describe('Start and end line numbers [start, end]'),
            description: z
                .string()
                .describe('Detailed description of the finding'),
            supporting_tool_calls: z
                .array(z.string())
                .describe('Names of tools used to build this finding'),
            disproof_attempted: z
                .boolean()
                .describe('Whether you attempted to disprove this finding'),
            disproof_method: z
                .string()
                .describe(
                    'How you attempted to disprove (empty string if not attempted)'
                ),
            disproof_result: z
                .string()
                .describe(
                    'Result of disproof attempt (empty string if not attempted)'
                ),
            verifiable_claims: z
                .array(
                    z.object({
                        claim_type: z.enum([
                            'symbol_unused',
                            'type_mismatch',
                            'symbol_missing',
                            'not_exported',
                            'no_callers',
                            'no_implementation',
                        ]),
                        file: z.string(),
                        line: z.number(),
                        symbol: z.string(),
                        assertion: z.string(),
                    })
                )
                .optional()
                .describe('Claims that can be validated by LSP'),
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
            category: args.category,
            title: args.title,
            file: args.file,
            lineRange: args.line_range,
            description: args.description,
            supportingToolCalls: args.supporting_tool_calls,
            disproof: {
                attempted: args.disproof_attempted,
                method: args.disproof_method,
                result: args.disproof_result,
            },
            verifiableClaims: (args.verifiable_claims ?? []).map((c) => ({
                claimType: c.claim_type,
                file: c.file,
                line: c.line,
                symbol: c.symbol,
                assertion: c.assertion,
            })),
        });

        const lspNote =
            finding.verifiableClaims.length > 0
                ? ` (${finding.verifiableClaims.length} verifiable claims — LSP validation pending)`
                : '';

        return toolSuccess(
            `Finding recorded: [${finding.id}] ${finding.severity} — ${finding.title}${lspNote}`
        );
    }
}
