import * as z from 'zod';
import { BaseTool } from './baseTool';
import { toolSuccess, toolError } from '../types/toolResultTypes';
import type { ToolResult } from '../types/toolResultTypes';
import type { ExecutionContext } from '../types/executionContext';

export class RecordEvidenceTool extends BaseTool {
    name = 'record_evidence';
    description =
        'Record a structured evidence entry to the shared evidence ledger. Use this when you discover a fact that would be valuable to other agents investigating related files. Record only high-value observations — types, call patterns, error handling presence, design intent comments.';

    schema = z
        .object({
            category: z
                .enum([
                    'behavior_observation',
                    'type_constraint',
                    'caller_pattern',
                    'error_handling',
                    'api_contract',
                    'design_intent',
                    'test_coverage',
                ])
                .describe('Category of evidence being recorded'),
            file: z.string().describe('File path where the evidence was found'),
            symbol: z
                .string()
                .optional()
                .describe(
                    'Symbol name if evidence relates to a specific symbol'
                ),
            line: z
                .number()
                .optional()
                .describe('Line number where evidence was found'),
            claim: z
                .string()
                .describe(
                    'Concise factual claim (e.g., "Function processItems has 30 callers across 5 files")'
                ),
            raw_snippet: z
                .string()
                .optional()
                .describe('Relevant code snippet supporting the claim'),
            confidence: z
                .enum(['high', 'medium', 'low'])
                .describe('Confidence in the claim'),
            source: z
                .enum(['tool_result', 'lsp_query', 'observation'])
                .describe('How the evidence was obtained'),
        })
        .strict();

    async execute(
        args: z.infer<typeof this.schema>,
        context: ExecutionContext
    ): Promise<ToolResult> {
        const ledger = context.evidenceLedger;
        if (!ledger) {
            return toolError('Evidence ledger not available in this context');
        }

        const entry = ledger.record({
            agentId: context.currentAgentId ?? 'unknown',
            category: args.category,
            file: args.file,
            symbol: args.symbol ?? undefined,
            line: args.line ?? undefined,
            claim: args.claim,
            rawSnippet: args.raw_snippet ?? undefined,
            confidence: args.confidence,
            source: args.source,
        });

        return toolSuccess(
            `Evidence recorded: [${entry.id}] ${entry.category} — ${entry.claim}`
        );
    }
}
