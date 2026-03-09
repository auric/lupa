import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RecordFindingTool } from '../tools/recordFindingTool';
import { createMockExecutionContext } from './testUtils/mockFactories';
import { FindingStore } from '../sessions/findingStore';

vi.mock('../services/loggingService', () => ({
    Log: {
        info: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
    },
}));

const BASE_FINDING_ARGS = {
    severity: 'HIGH' as const,
    category: 'error-handling',
    title: 'Missing error handler',
    file: 'src/api.ts',
    line_range: [10, 20] as [number, number],
    description: 'The catch block is empty and swallows errors silently.',
    supporting_tool_calls: ['read_file', 'find_symbol'],
    disproof_attempted: true,
    disproof_method: 'Checked if error is logged elsewhere',
    disproof_result: 'No other error handling found',
};

describe('RecordFindingTool', () => {
    let tool: RecordFindingTool;

    beforeEach(() => {
        vi.clearAllMocks();
        tool = new RecordFindingTool();
    });

    it('should have correct name', () => {
        expect(tool.name).toBe('record_finding');
    });

    it('records finding to store and returns success with finding id', async () => {
        const store = new FindingStore();
        const ctx = createMockExecutionContext({
            findingStore: store,
            currentAgentId: 'root',
        });

        const result = await tool.execute(BASE_FINDING_ARGS, ctx);

        expect(result.success).toBe(true);
        expect(result.data).toContain('Finding recorded');
        expect(result.data).toContain('finding-');
        expect(result.data).toContain('HIGH');
        expect(result.data).toContain('Missing error handler');
        expect(store.size).toBe(1);
    });

    it('returns error when no findingStore in context', async () => {
        const ctx = createMockExecutionContext({
            findingStore: undefined,
        });

        const result = await tool.execute(BASE_FINDING_ARGS, ctx);

        expect(result.success).toBe(false);
        expect(result.error).toContain('Finding store not available');
    });

    it('passes correct arguments to store', async () => {
        const store = new FindingStore();
        const recordSpy = vi.spyOn(store, 'record');
        const ctx = createMockExecutionContext({
            findingStore: store,
            currentAgentId: 'child-1',
        });

        await tool.execute(BASE_FINDING_ARGS, ctx);

        expect(recordSpy).toHaveBeenCalledWith({
            agentId: 'child-1',
            severity: 'HIGH',
            category: 'error-handling',
            title: 'Missing error handler',
            file: 'src/api.ts',
            lineRange: [10, 20],
            description:
                'The catch block is empty and swallows errors silently.',
            supportingToolCalls: ['read_file', 'find_symbol'],
            disproof: {
                attempted: true,
                method: 'Checked if error is logged elsewhere',
                result: 'No other error handling found',
            },
            verifiableClaims: [],
        });
    });

    it('maps verifiable claims correctly', async () => {
        const store = new FindingStore();
        const recordSpy = vi.spyOn(store, 'record');
        const ctx = createMockExecutionContext({
            findingStore: store,
            currentAgentId: 'root',
        });

        await tool.execute(
            {
                ...BASE_FINDING_ARGS,
                verifiable_claims: [
                    {
                        claim_type: 'symbol_unused',
                        file: 'src/utils.ts',
                        line: 5,
                        symbol: 'helperFn',
                        assertion: 'helperFn has no callers',
                    },
                ],
            },
            ctx
        );

        expect(recordSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                verifiableClaims: [
                    {
                        claimType: 'symbol_unused',
                        file: 'src/utils.ts',
                        line: 5,
                        symbol: 'helperFn',
                        assertion: 'helperFn has no callers',
                    },
                ],
            })
        );
    });

    it('includes verifiable claim count in response', async () => {
        const store = new FindingStore();
        const ctx = createMockExecutionContext({
            findingStore: store,
            currentAgentId: 'root',
        });

        const result = await tool.execute(
            {
                ...BASE_FINDING_ARGS,
                verifiable_claims: [
                    {
                        claim_type: 'no_callers',
                        file: 'src/a.ts',
                        line: 1,
                        symbol: 'fn',
                        assertion: 'fn has no callers',
                    },
                    {
                        claim_type: 'symbol_unused',
                        file: 'src/b.ts',
                        line: 2,
                        symbol: 'val',
                        assertion: 'val is unused',
                    },
                ],
            },
            ctx
        );

        expect(result.data).toContain('2 verifiable claims');
        expect(result.data).toContain('LSP validation pending');
    });

    it('uses "unknown" agentId when currentAgentId is not set', async () => {
        const store = new FindingStore();
        const recordSpy = vi.spyOn(store, 'record');
        const ctx = createMockExecutionContext({ findingStore: store });

        await tool.execute(BASE_FINDING_ARGS, ctx);

        expect(recordSpy).toHaveBeenCalledWith(
            expect.objectContaining({ agentId: 'unknown' })
        );
    });
});
