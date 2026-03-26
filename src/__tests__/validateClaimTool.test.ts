import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ValidateClaimTool } from '../tools/validateClaimTool';
import { createMockExecutionContext } from './testUtils/mockFactories';
import type { LspValidationService } from '../services/lspValidationService';
import type { ClaimValidationResult } from '../types/claimTypes';

vi.mock('../services/loggingService', () => ({
    Log: {
        info: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
    },
}));

function createMockLspValidation(
    overrides: Partial<LspValidationService> = {}
): LspValidationService {
    return {
        validate: vi.fn(),
        ...overrides,
    } as unknown as LspValidationService;
}

describe('ValidateClaimTool', () => {
    let tool: ValidateClaimTool;
    let mockLsp: LspValidationService;

    beforeEach(() => {
        vi.clearAllMocks();
        mockLsp = createMockLspValidation();
        tool = new ValidateClaimTool(mockLsp);
    });

    it('should have correct name and schema', () => {
        expect(tool.name).toBe('validate_claim');
        expect(tool.schema).toBeDefined();
    });

    it('returns formatted success text for verified claim', async () => {
        const result: ClaimValidationResult = {
            claimType: 'symbol_unused',
            verified: true,
            confidence: 'definitive',
            evidence: '0 references found',
            groundTruth: 'Symbol has no references',
        };
        vi.mocked(mockLsp.validate).mockResolvedValue(result);

        const toolResult = await tool.execute(
            {
                claim_type: 'symbol_unused',
                file: 'src/foo.ts',
                line: 10,
                symbol: 'unusedFn',
            },
            createMockExecutionContext()
        );

        expect(toolResult.success).toBe(true);
        expect(toolResult.data).toContain('✅');
        expect(toolResult.data).toContain('VERIFIED');
        expect(toolResult.data).toContain('Confidence: definitive');
        expect(toolResult.data).toContain('Evidence: 0 references found');
        expect(toolResult.data).toContain(
            'Ground truth: Symbol has no references'
        );
        expect(toolResult.data).toContain(
            "proceed to devil's advocate think checkpoint"
        );
    });

    it('returns formatted text for non-verified claim', async () => {
        const result: ClaimValidationResult = {
            claimType: 'no_callers',
            verified: false,
            confidence: 'definitive',
            evidence: '5 callers found',
            groundTruth: 'Function is called in 5 files',
        };
        vi.mocked(mockLsp.validate).mockResolvedValue(result);

        const toolResult = await tool.execute(
            {
                claim_type: 'no_callers',
                file: 'src/bar.ts',
                line: 20,
                symbol: 'processItems',
            },
            createMockExecutionContext()
        );

        expect(toolResult.success).toBe(true);
        expect(toolResult.data).toContain('❌');
        expect(toolResult.data).toContain('NOT VERIFIED');
        expect(toolResult.data).toContain('Confidence: definitive');
        expect(toolResult.data).toContain('Claim DISPROVED');
    });

    it('returns formatted text for inconclusive claim', async () => {
        const result: ClaimValidationResult = {
            claimType: 'type_mismatch',
            verified: false,
            confidence: 'inconclusive',
            evidence: 'Could not resolve type information',
            groundTruth: '',
        };
        vi.mocked(mockLsp.validate).mockResolvedValue(result);

        const toolResult = await tool.execute(
            {
                claim_type: 'type_mismatch',
                file: 'src/baz.ts',
                line: 5,
                symbol: 'myVar',
            },
            createMockExecutionContext()
        );

        expect(toolResult.success).toBe(true);
        expect(toolResult.data).toContain('❓');
        expect(toolResult.data).toContain('NOT VERIFIED');
        expect(toolResult.data).toContain('Confidence: inconclusive');
        expect(toolResult.data).toContain('Inconclusive');
    });

    it('passes correct ClaimValidationRequest to service', async () => {
        vi.mocked(mockLsp.validate).mockResolvedValue({
            claimType: 'symbol_missing',
            verified: true,
            confidence: 'definitive',
            evidence: 'Symbol not found',
            groundTruth: '',
        });

        const ctx = createMockExecutionContext();
        await tool.execute(
            {
                claim_type: 'symbol_missing',
                file: 'src/utils.ts',
                line: 42,
                symbol: 'helperFn',
                expected_value: 'string',
            },
            ctx
        );

        expect(mockLsp.validate).toHaveBeenCalledWith(
            {
                claimType: 'symbol_missing',
                file: 'src/utils.ts',
                line: 42,
                symbol: 'helperFn',
                expectedValue: 'string',
            },
            ctx.cancellationToken
        );
    });

    it('handles optional expected_value as undefined', async () => {
        vi.mocked(mockLsp.validate).mockResolvedValue({
            claimType: 'not_exported',
            verified: true,
            confidence: 'definitive',
            evidence: 'Not exported',
            groundTruth: '',
        });

        const ctx = createMockExecutionContext();
        await tool.execute(
            {
                claim_type: 'not_exported',
                file: 'src/internal.ts',
                line: 1,
                symbol: 'secretFn',
            },
            ctx
        );

        expect(mockLsp.validate).toHaveBeenCalledWith(
            expect.objectContaining({ expectedValue: undefined }),
            ctx.cancellationToken
        );
    });

    it('omits groundTruth line when empty', async () => {
        vi.mocked(mockLsp.validate).mockResolvedValue({
            claimType: 'symbol_unused',
            verified: true,
            confidence: 'definitive',
            evidence: 'no refs',
            groundTruth: '',
        });

        const toolResult = await tool.execute(
            {
                claim_type: 'symbol_unused',
                file: 'src/a.ts',
                line: 1,
                symbol: 'x',
            },
            createMockExecutionContext()
        );

        expect(toolResult.data).not.toContain('Ground truth');
    });

    it('handles no_implementation claim type', async () => {
        const result: ClaimValidationResult = {
            claimType: 'no_implementation',
            verified: true,
            confidence: 'definitive',
            evidence: 'No implementation found for declared interface method',
            groundTruth: 'Interface method has no concrete implementation',
        };
        vi.mocked(mockLsp.validate).mockResolvedValue(result);

        const ctx = createMockExecutionContext();
        const toolResult = await tool.execute(
            {
                claim_type: 'no_implementation',
                file: 'src/interfaces.ts',
                line: 15,
                symbol: 'processData',
            },
            ctx
        );

        expect(toolResult.success).toBe(true);
        expect(toolResult.data).toContain('✅');
        expect(toolResult.data).toContain('VERIFIED');
        expect(toolResult.data).toContain('no_implementation');
        expect(toolResult.data).toContain('Confidence: definitive');
        expect(toolResult.data).toContain(
            'Evidence: No implementation found for declared interface method'
        );
        expect(toolResult.data).toContain(
            'Ground truth: Interface method has no concrete implementation'
        );
        expect(mockLsp.validate).toHaveBeenCalledWith(
            {
                claimType: 'no_implementation',
                file: 'src/interfaces.ts',
                line: 15,
                symbol: 'processData',
                expectedValue: undefined,
            },
            ctx.cancellationToken
        );
    });

    describe('normalizeArgs', () => {
        it('should default to symbol_unused when claim_type is missing', () => {
            const result = tool.normalizeArgs({
                file: 'src/service.ts',
                line: 42,
                symbol: 'parsedDiff',
            });

            expect(result.claim_type).toBe('symbol_unused');
        });

        it('should default to type_mismatch when expected_value is present', () => {
            const result = tool.normalizeArgs({
                file: 'src/service.ts',
                line: 42,
                symbol: 'count',
                expected_value: 'number',
            });

            expect(result.claim_type).toBe('type_mismatch');
        });

        it('should not modify args when claim_type is valid', () => {
            const result = tool.normalizeArgs({
                claim_type: 'no_callers',
                file: 'src/service.ts',
                line: 42,
                symbol: 'helperFn',
            });

            expect(result.claim_type).toBe('no_callers');
        });

        it('should handle empty string claim_type', () => {
            const result = tool.normalizeArgs({
                claim_type: '',
                file: 'src/service.ts',
                line: 42,
                symbol: 'parsedDiff',
            });

            expect(result.claim_type).toBe('symbol_unused');
        });
    });
});
