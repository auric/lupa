import { vi, describe, it, expect, beforeEach } from 'vitest';
import { createSelfReflectionStep } from '../services/pipeline/steps/selfReflectionStep';
import type { PipelineContext } from '../services/pipeline/pipelineTypes';
import { createMockExecutionContext } from './testUtils/mockFactories';
import { FindingStore } from '../sessions/findingStore';
import type { RecordedFinding } from '../types/findingTypes';

vi.mock('../services/selfReflectionScorer', () => ({
    runSelfReflection: vi.fn(),
}));

import { runSelfReflection } from '../services/selfReflectionScorer';

const mockRunSelfReflection = vi.mocked(runSelfReflection);

type RecordedFindingInput = Omit<
    RecordedFinding,
    'id' | 'timestamp' | 'lspValidation'
>;

function createRecordedFindingInput(
    overrides: Partial<RecordedFindingInput> = {}
): RecordedFindingInput {
    return {
        agentId: 'root',
        severity: 'HIGH',
        category: 'logic_error',
        title: 'Test Finding',
        file: 'a.ts',
        lineRange: [1, 2],
        description: 'desc',
        affectedComponent: 'testComponent()',
        failureMechanism: 'runtime_exception',
        supportingToolCalls: [],
        disproof: {
            attempted: false,
            method: 'not-attempted',
            result: 'No disproof attempt was made',
        },
        verifiableClaims: [],
        ...overrides,
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
        executionContext: createMockExecutionContext(),
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
            hitMaxIterations: false,
            wasCancelled: false,
            hitRateLimit: false,
            degraded: false,
            exitReason: undefined,
        } as any,
        systemPrompt: 'test prompt',
        availableTools: [],
        handler: {
            onToolCallComplete: vi.fn(),
        } as any,
        findingValidator: {} as any,
        ...overrides,
    };
}

describe('createSelfReflectionStep', () => {
    let step: ReturnType<typeof createSelfReflectionStep>;

    beforeEach(() => {
        vi.clearAllMocks();
        step = createSelfReflectionStep();
    });

    describe('shouldRun', () => {
        it('returns false when findingStore is empty', () => {
            const context = createMockContext();
            expect(step.shouldRun(context)).toBe(false);
        });

        it('returns true when findingStore has findings', () => {
            const store = new FindingStore();
            store.record(
                createRecordedFindingInput({
                    title: 'Bug',
                })
            );
            const context = createMockContext({ findingStore: store });
            expect(step.shouldRun(context)).toBe(true);
        });
    });

    describe('execute', () => {
        it('filters out scores for dropped findings', async () => {
            const store = new FindingStore();
            const kept = store.record(
                createRecordedFindingInput({
                    title: 'Kept Finding',
                })
            );
            const dropped = store.record(
                createRecordedFindingInput({
                    severity: 'LOW',
                    title: 'Dropped Finding',
                    file: 'b.ts',
                    lineRange: [5, 6],
                    description: 'will be dropped',
                })
            );

            mockRunSelfReflection.mockImplementation(async (options) => {
                options.findingStore.remove(dropped.id);
                return {
                    scores: [
                        {
                            findingId: kept.id,
                            title: 'Kept Finding',
                            score: 8,
                            rationale: 'Solid evidence',
                        },
                        {
                            findingId: dropped.id,
                            title: 'Dropped Finding',
                            score: 3,
                            rationale: 'Speculative',
                        },
                    ],
                    dropped: ['Dropped Finding'],
                    kept: ['Kept Finding'],
                };
            });

            const context = createMockContext({ findingStore: store });
            const result = await step.execute(context);

            // Only the kept finding's score should be in selfReflectionScores
            expect(context.selfReflectionScores).toHaveLength(1);
            expect(context.selfReflectionScores[0].findingId).toBe(kept.id);
            expect(context.selfReflectionScores[0].title).toBe('Kept Finding');

            // The result should report the dropped finding
            expect(result.findingsDropped).toEqual(['Dropped Finding']);
        });

        it('keeps all scores when no findings are dropped', async () => {
            const store = new FindingStore();
            const f1 = store.record(
                createRecordedFindingInput({
                    title: 'Finding A',
                })
            );
            const f2 = store.record(
                createRecordedFindingInput({
                    severity: 'MEDIUM',
                    category: 'error_handling_gap',
                    title: 'Finding B',
                    file: 'b.ts',
                    lineRange: [3, 4],
                })
            );
            const onToolCallComplete = vi.fn();

            mockRunSelfReflection.mockImplementation(async (options) => {
                options.handler.onToolCallComplete?.(
                    'call-1',
                    'score_finding',
                    {
                        finding_id: f1.id,
                        score: 9,
                        rationale: 'Verified',
                    },
                    'ok',
                    true,
                    undefined,
                    1
                );

                return {
                    scores: [
                        {
                            findingId: f1.id,
                            title: 'Finding A',
                            score: 9,
                            rationale: 'Verified',
                        },
                        {
                            findingId: f2.id,
                            title: 'Finding B',
                            score: 7,
                            rationale: 'Evidence-backed',
                        },
                    ],
                    dropped: [],
                    kept: ['Finding A', 'Finding B'],
                };
            });

            const context = createMockContext({
                findingStore: store,
                handler: {
                    onToolCallComplete,
                } as any,
            });
            await step.execute(context);

            expect(context.selfReflectionScores).toHaveLength(2);
            expect(onToolCallComplete).toHaveBeenCalledOnce();
        });

        it('restores conversation after self-reflection', async () => {
            const store = new FindingStore();
            store.record(
                createRecordedFindingInput({
                    title: 'Bug',
                })
            );

            mockRunSelfReflection.mockResolvedValue({
                scores: [],
                dropped: [],
                kept: [],
            });

            const context = createMockContext({ findingStore: store });
            await step.execute(context);

            expect(
                context.conversationManager.clearHistory
            ).toHaveBeenCalledOnce();
            expect(
                context.conversationManager.prependHistoryMessages
            ).toHaveBeenCalledWith([]);
        });

        it('restores conversation even when self-reflection throws', async () => {
            const store = new FindingStore();
            const originalFinding = store.record(
                createRecordedFindingInput({
                    title: 'Bug',
                })
            );
            const existingScores = [
                {
                    findingId: originalFinding.id,
                    title: 'Existing score',
                    score: 9,
                    rationale: 'already recorded',
                },
            ];

            mockRunSelfReflection.mockImplementation(async (options) => {
                options.findingStore.remove(originalFinding.id);
                throw new Error('reflection failed');
            });

            const context = createMockContext({
                findingStore: store,
                selfReflectionScores: existingScores,
            });

            await expect(step.execute(context)).rejects.toThrow(
                'reflection failed'
            );
            expect(store.size).toBe(1);
            expect(store.getById(originalFinding.id)?.title).toBe('Bug');
            expect(context.selfReflectionScores).toEqual(existingScores);
            expect(
                context.conversationManager.clearHistory
            ).toHaveBeenCalledOnce();
            expect(
                context.conversationManager.prependHistoryMessages
            ).toHaveBeenCalledWith([]);
        });

        it('rolls back self-reflection state when conversation hits max iterations', async () => {
            const store = new FindingStore();
            const f1 = store.record(
                createRecordedFindingInput({
                    title: 'Finding A',
                })
            );
            const f2 = store.record(
                createRecordedFindingInput({
                    severity: 'LOW',
                    title: 'Finding B',
                    file: 'b.ts',
                    lineRange: [3, 4],
                })
            );
            const existingScores = [
                {
                    findingId: f1.id,
                    title: 'Existing score',
                    score: 10,
                    rationale: 'baseline',
                },
            ];
            const onToolCallComplete = vi.fn();

            mockRunSelfReflection.mockImplementation(async (options) => {
                options.handler.onToolCallComplete?.(
                    'call-1',
                    'score_finding',
                    {
                        finding_id: f2.id,
                        score: 3,
                        rationale: 'Speculative',
                    },
                    'ok',
                    true,
                    undefined,
                    1
                );
                options.findingStore.remove(f2.id);
                return {
                    scores: [
                        {
                            findingId: f1.id,
                            title: 'Finding A',
                            score: 8,
                            rationale: 'Verified',
                        },
                        {
                            findingId: f2.id,
                            title: 'Finding B',
                            score: 3,
                            rationale: 'Speculative',
                        },
                    ],
                    dropped: ['Finding B'],
                    kept: ['Finding A'],
                };
            });

            const context = createMockContext({
                findingStore: store,
                selfReflectionScores: existingScores,
                handler: {
                    onToolCallComplete,
                } as any,
                conversationRunner: {
                    hitMaxIterations: true,
                    wasCancelled: false,
                    hitRateLimit: false,
                    degraded: false,
                    exitReason: undefined,
                } as any,
            });
            const result = await step.execute(context);

            expect(result.budgetExhausted).toBe(true);
            expect(result.summary).toContain('hit iteration limit');
            expect(result.findingsDropped).toEqual([]);
            expect(result.summary).toContain(
                'Original self-reflection state preserved'
            );
            expect(store.size).toBe(2);
            expect(store.getById(f2.id)?.title).toBe('Finding B');
            expect(context.selfReflectionScores).toEqual(existingScores);
            expect(onToolCallComplete).not.toHaveBeenCalled();
            expect(
                context.conversationManager.clearHistory
            ).toHaveBeenCalledOnce();
            expect(
                context.conversationManager.prependHistoryMessages
            ).toHaveBeenCalledWith([]);
        });
    });
});
