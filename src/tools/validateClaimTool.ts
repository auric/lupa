import * as z from 'zod';
import { BaseTool } from './baseTool';
import { toolSuccess } from '../types/toolResultTypes';
import type { ToolResult } from '../types/toolResultTypes';
import type { ExecutionContext } from '../types/executionContext';
import type { LspValidationService } from '../services/lspValidationService';

export class ValidateClaimTool extends BaseTool {
    name = 'validate_claim';
    description =
        'Verify a factual claim about code using the Language Server Protocol (LSP). ' +
        'Returns compiler-grade ground truth — no LLM judgment involved. ' +
        'Use to verify claims like "symbol X is unused", "type Y is nullable", "function Z has no callers". ' +
        'Claims with definitive results should override LLM reasoning.';

    schema = z
        .object({
            claim_type: z
                .enum([
                    'symbol_unused',
                    'type_mismatch',
                    'symbol_missing',
                    'not_exported',
                    'no_callers',
                    'no_implementation',
                ])
                .describe('Type of claim to verify'),
            file: z.string().describe('File path (relative to repo root)'),
            line: z
                .number()
                .describe('Line number where the symbol appears (1-indexed)'),
            symbol: z.string().describe('Symbol name to validate'),
            expected_value: z
                .string()
                .optional()
                .describe('Expected type/value for type_mismatch claims'),
        })
        .strict();

    constructor(private readonly lspValidation: LspValidationService) {
        super();
    }

    async execute(
        args: z.infer<typeof this.schema>,
        context: ExecutionContext
    ): Promise<ToolResult> {
        const result = await this.lspValidation.validate(
            {
                claimType: args.claim_type,
                file: args.file,
                line: args.line,
                symbol: args.symbol,
                expectedValue: args.expected_value ?? undefined,
            },
            context.cancellationToken
        );

        const statusIcon = result.verified
            ? '✅'
            : result.confidence === 'inconclusive'
              ? '❓'
              : '❌';
        const formatted = [
            `${statusIcon} Claim "${args.claim_type}" for ${args.symbol}: ${result.verified ? 'VERIFIED' : 'NOT VERIFIED'}`,
            `Confidence: ${result.confidence}`,
            `Evidence: ${result.evidence}`,
            result.groundTruth ? `Ground truth: ${result.groundTruth}` : '',
        ]
            .filter(Boolean)
            .join('\n');

        return toolSuccess(formatted);
    }
}
