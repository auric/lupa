import * as z from 'zod';
import { BaseTool } from './baseTool';
import { toolSuccess } from '../types/toolResultTypes';
import type { ToolResult } from '../types/toolResultTypes';
import type { ExecutionContext } from '../types/executionContext';
import type { LspValidationService } from '../services/lspValidationService';
import { Log } from '../services/loggingService';

export class ValidateClaimTool extends BaseTool {
    name = 'validate_claim';
    description =
        'REQUIRED before every record_finding call. ' +
        'Verify a factual claim about code using the Language Server Protocol (LSP). ' +
        'Returns compiler-grade ground truth — no LLM judgment involved. ' +
        'Use to verify claims like "symbol X is unused", "type Y is nullable", "function Z has no callers". ' +
        'If this tool disproves your claim, do NOT record the finding — drop it immediately. ' +
        'LSP results override LLM reasoning.';

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

    override normalizeArgs(
        args: Record<string, unknown>
    ): Record<string, unknown> {
        const claimType =
            typeof args.claim_type === 'string' ? args.claim_type.trim() : '';
        if (!claimType) {
            const inferred = args.expected_value
                ? 'type_mismatch'
                : 'symbol_unused';
            Log.warn(
                `validate_claim: claim_type missing — defaulting to '${inferred}' for symbol '${args.symbol}'`
            );
            return { ...args, claim_type: inferred };
        }
        return args;
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
        const actionGuidance = result.verified
            ? "Claim verified — proceed to devil's advocate think checkpoint, then record_finding if it survives."
            : result.confidence === 'inconclusive'
              ? 'Inconclusive — gather more evidence before recording. Consider dropping if no stronger evidence exists.'
              : 'Claim DISPROVED — do NOT record this finding. Drop it and move on.';
        const formatted = [
            `${statusIcon} Claim "${args.claim_type}" for ${args.symbol}: ${result.verified ? 'VERIFIED' : 'NOT VERIFIED'}`,
            `Confidence: ${result.confidence}`,
            `Evidence: ${result.evidence}`,
            result.groundTruth ? `Ground truth: ${result.groundTruth}` : '',
            `Next: ${actionGuidance}`,
        ]
            .filter(Boolean)
            .join('\n');

        return toolSuccess(formatted);
    }
}
