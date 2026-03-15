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
    category: 'error_handling_gap' as const,
    title: 'Missing error handler',
    file: 'src/api.ts',
    line: 15,
    description: 'The catch block is empty and swallows errors silently.',
    verification_evidence:
        'search_for_pattern(catch, src/api.ts) showed empty catch block at line 15 with no logging or rethrow',
    disproof_note:
        'Checked if error is logged elsewhere — no other error handling found',
};

/** Tool call counts that satisfy minToolCallsBeforeFirstFinding for the default profile */
function investigatedToolCalls(): Map<string, number> {
    return new Map([
        ['get_file_diff', 3],
        ['search_for_pattern', 2],
    ]);
}

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
            toolCallCounts: investigatedToolCalls(),
            investigatedFiles: new Set(['src/api.ts']),
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

    it('passes correct arguments to store with defaults', async () => {
        const store = new FindingStore();
        const recordSpy = vi.spyOn(store, 'record');
        const ctx = createMockExecutionContext({
            findingStore: store,
            currentAgentId: 'child-1',
            toolCallCounts: investigatedToolCalls(),
            investigatedFiles: new Set(['src/api.ts']),
        });

        await tool.execute(BASE_FINDING_ARGS, ctx);

        expect(recordSpy).toHaveBeenCalledWith({
            agentId: 'child-1',
            severity: 'HIGH',
            category: 'error_handling_gap',
            title: 'Missing error handler',
            file: 'src/api.ts',
            lineRange: [15, 15],
            description:
                'The catch block is empty and swallows errors silently.',
            supportingToolCalls: [],
            disproof: {
                attempted: true,
                method: 'Checked if error is logged elsewhere — no other error handling found',
                result: 'Checked if error is logged elsewhere — no other error handling found',
            },
            verifiableClaims: [],
        });
    });

    it('always sets disproof.attempted=true since disproof_note is required', async () => {
        const store = new FindingStore();
        const recordSpy = vi.spyOn(store, 'record');
        const ctx = createMockExecutionContext({
            findingStore: store,
            currentAgentId: 'root',
            toolCallCounts: investigatedToolCalls(),
            investigatedFiles: new Set(['src/api.ts']),
        });

        await tool.execute(BASE_FINDING_ARGS, ctx);

        expect(recordSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                disproof: expect.objectContaining({ attempted: true }),
            })
        );
    });

    it('uses "unknown" agentId when currentAgentId is not set', async () => {
        const store = new FindingStore();
        const recordSpy = vi.spyOn(store, 'record');
        const ctx = createMockExecutionContext({
            findingStore: store,
            toolCallCounts: investigatedToolCalls(),
            investigatedFiles: new Set(['src/api.ts']),
        });

        await tool.execute(BASE_FINDING_ARGS, ctx);

        expect(recordSpy).toHaveBeenCalledWith(
            expect.objectContaining({ agentId: 'unknown' })
        );
    });

    it('passes verifiable_claims to finding store', async () => {
        const store = new FindingStore();
        const recordSpy = vi.spyOn(store, 'record');
        const context = createMockExecutionContext({
            findingStore: store,
            currentAgentId: 'test-agent',
            toolCallCounts: investigatedToolCalls(),
            investigatedFiles: new Set(['src/api.ts']),
        });

        await tool.execute(
            {
                ...BASE_FINDING_ARGS,
                verifiable_claims: [
                    {
                        claim_type: 'no_callers',
                        file: 'src/auth.ts',
                        line: 42,
                        symbol: 'hashPassword',
                        assertion:
                            'No callers handle the error from hashPassword',
                    },
                ],
            },
            context
        );

        expect(recordSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                verifiableClaims: [
                    {
                        claimType: 'no_callers',
                        file: 'src/auth.ts',
                        line: 42,
                        symbol: 'hashPassword',
                        assertion:
                            'No callers handle the error from hashPassword',
                    },
                ],
            })
        );
    });

    it('defaults verifiable_claims to empty array when omitted', async () => {
        const store = new FindingStore();
        const recordSpy = vi.spyOn(store, 'record');
        const context = createMockExecutionContext({
            findingStore: store,
            currentAgentId: 'test-agent',
            toolCallCounts: investigatedToolCalls(),
            investigatedFiles: new Set(['src/api.ts']),
        });

        await tool.execute(BASE_FINDING_ARGS, context);

        expect(recordSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                verifiableClaims: [],
            })
        );
    });

    it('passes multiple verifiable_claims', async () => {
        const store = new FindingStore();
        const recordSpy = vi.spyOn(store, 'record');
        const context = createMockExecutionContext({
            findingStore: store,
            currentAgentId: 'test-agent',
            toolCallCounts: investigatedToolCalls(),
            investigatedFiles: new Set(['src/api.ts']),
        });

        await tool.execute(
            {
                ...BASE_FINDING_ARGS,
                verifiable_claims: [
                    {
                        claim_type: 'symbol_missing',
                        file: 'src/a.ts',
                        line: 10,
                        symbol: 'foo',
                        assertion: 'foo does not exist',
                    },
                    {
                        claim_type: 'type_mismatch',
                        file: 'src/b.ts',
                        line: 20,
                        symbol: 'bar',
                        assertion: 'bar should be string not number',
                    },
                ],
            },
            context
        );

        expect(recordSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                verifiableClaims: expect.arrayContaining([
                    expect.objectContaining({
                        claimType: 'symbol_missing',
                        symbol: 'foo',
                    }),
                    expect.objectContaining({
                        claimType: 'type_mismatch',
                        symbol: 'bar',
                    }),
                ]),
            })
        );
    });

    describe('minToolCallsBeforeFirstFinding gate', () => {
        it('rejects first finding when insufficient investigation tool calls', async () => {
            const store = new FindingStore();
            const ctx = createMockExecutionContext({
                findingStore: store,
                toolCallCounts: new Map([['get_file_diff', 1]]), // only 1, default requires 2
            });

            const result = await tool.execute(BASE_FINDING_ARGS, ctx);

            expect(result.success).toBe(false);
            expect(result.error).toContain('insufficient investigation');
            expect(store.size).toBe(0);
        });

        it('accepts first finding when enough investigation tool calls', async () => {
            const store = new FindingStore();
            const ctx = createMockExecutionContext({
                findingStore: store,
                toolCallCounts: new Map([
                    ['get_file_diff', 1],
                    ['search_for_pattern', 1],
                ]),
                investigatedFiles: new Set(['src/api.ts']),
            });

            const result = await tool.execute(BASE_FINDING_ARGS, ctx);

            expect(result.success).toBe(true);
            expect(store.size).toBe(1);
        });

        it('does not count record_finding/retract_finding/submit_review as investigation', async () => {
            const store = new FindingStore();
            const ctx = createMockExecutionContext({
                findingStore: store,
                toolCallCounts: new Map([
                    ['record_finding', 5],
                    ['retract_finding', 3],
                    ['submit_review', 1],
                ]),
            });

            const result = await tool.execute(BASE_FINDING_ARGS, ctx);

            expect(result.success).toBe(false);
            expect(result.error).toContain('insufficient investigation');
        });

        it('skips gate for subsequent findings (store not empty)', async () => {
            const store = new FindingStore();
            // Pre-populate with a finding
            store.record({
                agentId: 'root',
                severity: 'LOW',
                category: 'logic_error',
                title: 'Existing finding',
                file: 'a.ts',
                lineRange: [1, 1],
                description: 'test',
                supportingToolCalls: [],
                disproof: { attempted: false, method: '', result: '' },
                verifiableClaims: [],
            });

            const ctx = createMockExecutionContext({
                findingStore: store,
                toolCallCounts: new Map(), // zero investigation calls
                investigatedFiles: new Set(['src/api.ts']),
            });

            const result = await tool.execute(BASE_FINDING_ARGS, ctx);

            expect(result.success).toBe(true);
            expect(store.size).toBe(2);
        });

        it('respects model-specific minToolCallsBeforeFirstFinding', async () => {
            const store = new FindingStore();
            const ctx = createMockExecutionContext({
                findingStore: store,
                toolCallCounts: new Map([['get_file_diff', 3]]),
                calibrationProfile: {
                    ...ctx_profile(),
                    investigationProtocol: {
                        minToolCallsBeforeFirstFinding: 5,
                        requiredToolsBeforeDone: [],
                        investigationPreamble: '',
                    },
                },
            });

            const result = await tool.execute(BASE_FINDING_ARGS, ctx);

            expect(result.success).toBe(false);
            expect(result.error).toContain('minimum 5 required');
        });
    });

    describe('file investigation gate', () => {
        it('rejects finding when file has not been investigated', async () => {
            const store = new FindingStore();
            const ctx = createMockExecutionContext({
                findingStore: store,
                toolCallCounts: investigatedToolCalls(),
                investigatedFiles: new Set<string>(),
            });

            const result = await tool.execute(BASE_FINDING_ARGS, ctx);

            expect(result.success).toBe(false);
            expect(result.error).toContain('you have not investigated');
            expect(store.size).toBe(0);
        });

        it('accepts finding when file has been investigated via read_file', async () => {
            const store = new FindingStore();
            const ctx = createMockExecutionContext({
                findingStore: store,
                toolCallCounts: investigatedToolCalls(),
                investigatedFiles: new Set(['src/api.ts']),
            });

            const result = await tool.execute(BASE_FINDING_ARGS, ctx);

            expect(result.success).toBe(true);
            expect(store.size).toBe(1);
        });

        it('matches files regardless of path separator style', async () => {
            const store = new FindingStore();
            const ctx = createMockExecutionContext({
                findingStore: store,
                toolCallCounts: investigatedToolCalls(),
                investigatedFiles: new Set(['src/api.ts']),
            });

            const result = await tool.execute(
                { ...BASE_FINDING_ARGS, file: 'src\\api.ts' },
                ctx
            );

            expect(result.success).toBe(true);
            expect(store.size).toBe(1);
        });

        it('matches files by suffix', async () => {
            const store = new FindingStore();
            const ctx = createMockExecutionContext({
                findingStore: store,
                toolCallCounts: investigatedToolCalls(),
                investigatedFiles: new Set(['src/api.ts']),
            });

            const result = await tool.execute(
                { ...BASE_FINDING_ARGS, file: 'd:/project/src/api.ts' },
                ctx
            );

            expect(result.success).toBe(true);
            expect(store.size).toBe(1);
        });

        it('skips gate when investigatedFiles is undefined', async () => {
            const store = new FindingStore();
            const ctx = createMockExecutionContext({
                findingStore: store,
                toolCallCounts: investigatedToolCalls(),
                investigatedFiles: undefined,
            });

            const result = await tool.execute(BASE_FINDING_ARGS, ctx);

            expect(result.success).toBe(true);
            expect(store.size).toBe(1);
        });
    });
});

function ctx_profile() {
    return createMockExecutionContext().calibrationProfile;
}
