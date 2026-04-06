import { vi, describe, it, expect, beforeEach } from 'vitest';
import { createRewriteStep } from '../services/pipeline/steps/rewriteStep';
import type { PipelineContext } from '../services/pipeline/pipelineTypes';
import { createMockCancellationToken } from './testUtils/mockFactories';
import { FindingStore } from '../sessions/findingStore';
import type { RecordedFinding, FindingSeverity } from '../types/findingTypes';

function makeFinding(
    overrides: Partial<
        Omit<RecordedFinding, 'id' | 'timestamp' | 'lspValidation'>
    > = {}
) {
    return {
        agentId: overrides.agentId ?? 'agent-1',
        severity: overrides.severity ?? ('MEDIUM' as FindingSeverity),
        category: overrides.category ?? 'logic_error',
        title: overrides.title ?? 'Test finding',
        file: overrides.file ?? 'src/foo.ts',
        lineRange: overrides.lineRange ?? ([10, 20] as [number, number]),
        description: overrides.description ?? 'A test finding',
        affectedComponent: overrides.affectedComponent ?? 'someFunction()',
        failureMechanism: overrides.failureMechanism ?? 'wrong_return_value',
        supportingToolCalls: overrides.supportingToolCalls ?? [],
        disproof: overrides.disproof ?? {
            attempted: false,
            method: '',
            result: '',
        },
        verifiableClaims: overrides.verifiableClaims ?? [],
    };
}

function createMockContext(
    overrides: Partial<PipelineContext> = {}
): PipelineContext {
    return {
        droppedTitles: [],
        downgradedTitles: [],
        additionalToolCallRecords: [],
        selfReflectionScores: [],
        rewrittenAnalysis: undefined,
        findingStore: new FindingStore(),
        toolCallRecords: [],
        executionContext: {
            cancellationToken: createMockCancellationToken(),
        } as any,
        parsedDiff: [],
        calibrationProfile: {} as any,
        subagentExecutor: {} as any,
        conversationManager: {
            addUserMessage: vi.fn(),
            getHistory: vi.fn().mockReturnValue([]),
            clearHistory: vi.fn(),
            prependHistoryMessages: vi.fn(),
        } as any,
        conversationRunner: {
            run: vi.fn().mockResolvedValue('Rewritten review text'),
            hitMaxIterations: false,
            wasCancelled: false,
            hitRateLimit: false,
            hitQuotaExhausted: false,
            degraded: false,
            exitReason: undefined,
        } as any,
        systemPrompt: 'test prompt',
        availableTools: [
            { name: 'think', getVSCodeTool: vi.fn() },
            { name: 'submit_review', getVSCodeTool: vi.fn() },
            { name: 'retract_finding', getVSCodeTool: vi.fn() },
            { name: 'read_file', getVSCodeTool: vi.fn() },
        ] as any,
        handler: {
            onToolCallStart: vi.fn(),
            onToolCallComplete: vi.fn(),
        } as any,
        findingValidator: {} as any,
        ...overrides,
    };
}

describe('createRewriteStep', () => {
    let step: ReturnType<typeof createRewriteStep>;

    beforeEach(() => {
        step = createRewriteStep();
    });

    describe('shouldRun', () => {
        it('returns false when no dropped or downgraded titles', () => {
            const context = createMockContext();
            expect(step.shouldRun(context)).toBe(false);
        });

        it('returns true when there are dropped titles', () => {
            const context = createMockContext({
                droppedTitles: ['Finding A'],
            });
            expect(step.shouldRun(context)).toBe(true);
        });

        it('returns true when there are downgraded titles', () => {
            const context = createMockContext({
                downgradedTitles: ['Finding B'],
            });
            expect(step.shouldRun(context)).toBe(true);
        });
    });

    describe('execute', () => {
        it('sets rewrittenAnalysis on successful completion', async () => {
            const context = createMockContext({
                droppedTitles: ['Finding A'],
                selfReflectionScores: [
                    {
                        findingId: 'finding-1',
                        title: 'Finding A',
                        score: 8,
                        rationale: 'Verified',
                    },
                ],
            });

            await step.execute(context);

            expect(context.rewrittenAnalysis).toBe('Rewritten review text');
            expect(context.lastCommittedSelfReflectionScores).toEqual(
                context.selfReflectionScores
            );
            expect(context.conversationRunner.run).toHaveBeenCalled();
        });

        it('preserves original analysis when budget is exhausted', async () => {
            const context = createMockContext({
                droppedTitles: ['Finding A'],
                lastCommittedReviewText: 'Original analysis text',
                conversationRunner: {
                    run: vi.fn().mockResolvedValue('Partial garbage text'),
                    hitMaxIterations: true,
                    wasCancelled: false,
                    hitRateLimit: false,
                    hitQuotaExhausted: false,
                    degraded: false,
                    exitReason: undefined,
                } as any,
            });

            const result = await step.execute(context);

            expect(context.rewrittenAnalysis).toBe('Original analysis text');
            expect(result.budgetExhausted).toBe(true);
            expect(result.summary).toContain('hit iteration limit');
        });

        it('preserves original analysis when conversation is cancelled', async () => {
            const context = createMockContext({
                droppedTitles: ['Finding A'],
                lastCommittedReviewText: 'Original analysis text',
                conversationRunner: {
                    run: vi.fn().mockResolvedValue(''),
                    hitMaxIterations: false,
                    wasCancelled: true,
                    hitRateLimit: false,
                    hitQuotaExhausted: false,
                    degraded: false,
                    exitReason: undefined,
                } as any,
            });

            const result = await step.execute(context);

            expect(context.rewrittenAnalysis).toBe('Original analysis text');
            expect(result.budgetExhausted).toBeFalsy();
            expect(result.summary).toContain('was cancelled');
        });

        it('preserves original analysis when rate limit is hit', async () => {
            const context = createMockContext({
                droppedTitles: ['Finding A'],
                lastCommittedReviewText: 'Original analysis text',
                conversationRunner: {
                    run: vi
                        .fn()
                        .mockResolvedValue(
                            'Rate limited by the API after multiple retries.'
                        ),
                    hitMaxIterations: false,
                    wasCancelled: false,
                    hitRateLimit: true,
                    hitQuotaExhausted: false,
                    degraded: true,
                    exitReason: 'rate-limited',
                } as any,
            });

            const result = await step.execute(context);

            expect(context.rewrittenAnalysis).toBe('Original analysis text');
            expect(result.budgetExhausted).toBeFalsy();
            expect(result.summary).toContain('hit rate limit');
        });

        it('restores finding store state when rewrite exits abnormally', async () => {
            const store = new FindingStore();
            const kept = store.record(
                makeFinding({ title: 'Kept finding', severity: 'HIGH' })
            );
            const removed = store.record(
                makeFinding({ title: 'Removed finding', severity: 'LOW' })
            );

            const context = createMockContext({
                droppedTitles: ['Finding A'],
                findingStore: store,
                conversationRunner: {
                    run: vi.fn().mockImplementation(async () => {
                        store.updateSeverity(kept.id, 'LOW');
                        store.remove(removed.id);
                        return 'Partial rewrite text';
                    }),
                    hitMaxIterations: false,
                    wasCancelled: false,
                    hitRateLimit: true,
                    hitQuotaExhausted: false,
                    degraded: true,
                    exitReason: 'rate-limited',
                } as any,
            });

            const result = await step.execute(context);

            expect(store.size).toBe(2);
            expect(store.getById(kept.id)?.severity).toBe('HIGH');
            expect(store.getById(removed.id)?.title).toBe('Removed finding');
            expect(context.rewrittenAnalysis).toBeUndefined();
            expect(result.summary).toContain('hit rate limit');
            expect(
                context.conversationManager.clearHistory
            ).toHaveBeenCalledOnce();
            expect(
                context.conversationManager.prependHistoryMessages
            ).toHaveBeenCalledWith([]);
        });

        it('restores the last committed review state when rewrite cannot finish', async () => {
            const committedStore = new FindingStore();
            const committed = committedStore.record(
                makeFinding({ title: 'Committed finding', severity: 'HIGH' })
            );

            const store = new FindingStore();
            const downgraded = store.record(
                makeFinding({ title: 'Committed finding', severity: 'LOW' })
            );

            const context = createMockContext({
                droppedTitles: ['Finding A'],
                findingStore: store,
                rewrittenAnalysis: 'Committed review text',
                selfReflectionScores: [
                    {
                        findingId: downgraded.id,
                        title: 'Committed finding',
                        score: 2,
                        rationale: 'Should be rolled back',
                    },
                ],
                lastCommittedReviewText: 'Committed review text',
                lastCommittedFindingStoreSnapshot:
                    committedStore.createSnapshot(),
                lastCommittedSelfReflectionScores: [],
                conversationRunner: {
                    run: vi.fn().mockImplementation(async () => {
                        store.remove(downgraded.id);
                        return 'Partial rewrite text';
                    }),
                    hitMaxIterations: true,
                    wasCancelled: false,
                    hitRateLimit: false,
                    hitQuotaExhausted: false,
                    degraded: false,
                    exitReason: undefined,
                } as any,
            });

            const result = await step.execute(context);

            expect(context.rewrittenAnalysis).toBe('Committed review text');
            expect(store.size).toBe(1);
            expect(store.getAll()[0]?.title).toBe('Committed finding');
            expect(store.getById(committed.id)?.severity).toBe('HIGH');
            expect(context.selfReflectionScores).toEqual([]);
            expect(result.summary).toContain('hit iteration limit');
        });

        it('restores finding store state when rewrite run throws', async () => {
            const store = new FindingStore();
            const original = store.record(
                makeFinding({ title: 'Original finding', severity: 'HIGH' })
            );

            const context = createMockContext({
                droppedTitles: ['Finding A'],
                findingStore: store,
                conversationRunner: {
                    run: vi.fn().mockImplementation(async () => {
                        store.remove(original.id);
                        throw new Error('rewrite crashed');
                    }),
                    hitMaxIterations: false,
                    wasCancelled: false,
                } as any,
            });

            await expect(step.execute(context)).rejects.toThrow(
                'rewrite crashed'
            );
            expect(store.size).toBe(1);
            expect(store.getById(original.id)?.title).toBe('Original finding');
            expect(
                context.conversationManager.clearHistory
            ).toHaveBeenCalledOnce();
            expect(
                context.conversationManager.prependHistoryMessages
            ).toHaveBeenCalledWith([]);
        });

        it('filters tools to only allowed set', async () => {
            const context = createMockContext({
                droppedTitles: ['Finding A'],
            });

            await step.execute(context);

            const runCall = vi.mocked(context.conversationRunner.run).mock
                .calls[0];
            const config = runCall[0];
            const toolNames = config.tools.map((t: any) => t.name);
            expect(toolNames).toEqual([
                'think',
                'submit_review',
                'retract_finding',
            ]);
            expect(toolNames).not.toContain('read_file');
        });

        it('uses requiresExplicitCompletion', async () => {
            const context = createMockContext({
                droppedTitles: ['Finding A'],
            });

            await step.execute(context);

            const runCall = vi.mocked(context.conversationRunner.run).mock
                .calls[0];
            const config = runCall[0];
            expect(config.requiresExplicitCompletion).toBe(true);
        });

        it('includes dropped findings in user message', async () => {
            const context = createMockContext({
                droppedTitles: ['Bug in auth', 'Missing validation'],
            });

            await step.execute(context);

            const addMessage = vi.mocked(
                context.conversationManager.addUserMessage
            );
            expect(addMessage).toHaveBeenCalledOnce();
            const message = addMessage.mock.calls[0][0];
            expect(message).toContain('Bug in auth');
            expect(message).toContain('Missing validation');
        });

        it('includes downgraded findings in user message', async () => {
            const context = createMockContext({
                downgradedTitles: ['Severity reduced'],
            });

            await step.execute(context);

            const addMessage = vi.mocked(
                context.conversationManager.addUserMessage
            );
            const message = addMessage.mock.calls[0][0];
            expect(message).toContain('Severity reduced');
            expect(message).toContain('downgraded');
        });
    });
});
