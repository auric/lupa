import * as z from 'zod';
import { BaseTool } from './baseTool';
import { toolSuccess, toolError } from '../types/toolResultTypes';
import type { ToolResult } from '../types/toolResultTypes';
import type { ExecutionContext } from '../types/executionContext';

export class QueryEvidenceTool extends BaseTool {
    name = 'query_evidence';
    description =
        'Query the shared evidence ledger for observations recorded by any agent during this review. Use to check what other agents have discovered about a file, symbol, or topic before investigating yourself.';

    schema = z
        .object({
            file: z.string().optional().describe('Filter by file path'),
            symbol: z.string().optional().describe('Filter by symbol name'),
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
                .optional()
                .describe('Filter by evidence category'),
            text: z
                .string()
                .optional()
                .describe('Free-text search in claims and snippets'),
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

        const results = ledger.query({
            file: args.file ?? undefined,
            symbol: args.symbol ?? undefined,
            category: args.category ?? undefined,
            agentId: undefined,
            text: args.text ?? undefined,
        });

        if (results.length === 0) {
            return toolSuccess('No evidence entries match the query.');
        }

        const formatted = results
            .map(
                (e) =>
                    `[${e.id}] (${e.agentId}) ${e.category} | ${e.file}${e.symbol ? `:${e.symbol}` : ''}${e.line !== undefined ? `:L${e.line}` : ''}\n  ${e.claim}${e.rawSnippet ? `\n  \`\`\`\n  ${e.rawSnippet}\n  \`\`\`` : ''}`
            )
            .join('\n\n');

        return toolSuccess(
            `Found ${results.length} evidence entries:\n\n${formatted}`
        );
    }
}
