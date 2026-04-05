import { vi, describe, it, expect, beforeEach } from 'vitest';
import { createSelfReflectionStep } from '../services/pipeline/steps/selfReflectionStep';
import type { PipelineContext } from '../services/pipeline/pipelineTypes';
import { createMockCancellationToken } from './testUtils/mockFactories';
import { FindingStore } from '../sessions/findingStore';

vi.mock('../services/selfReflectionScorer', () => ({
    runSelfReflection: vi.fn(),
}));

import { runSelfReflection } from '../services/selfReflectionScorer';

const mockRunSelfReflection = vi.mocked(runSelfReflection);

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
            getMessageCount: vi.fn().mockReturnValue(5),
            truncateToMessageCount: vi.fn(),
        } as any,
        conversationRunner: {} as any,
        systemPrompt: 'test prompt',
        availableTools: [],
        handler: {} as any,
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
            store.record({
                agentId: 'root',
                severity: 'HIGH',
                category: 'logic_error',
                title: 'Bug',
                file: 'a.ts',
                lineRange: [1, 2],
                description: 'desc',
                supportingToolCalls: [],
                disproof: { attempted: false },
                verifiableClaims: [],
            });
            const context = createMockContext({ findingStore: store });
            expect(step.shouldRun(context)).toBe(true);
        });
    });

    describe('execute', () => {
        it('filters out scores for dropped findings', async () => {
            const store = new FindingStore();
            const kept = store.record({
                agentId: 'root',
                severity: 'HIGH',
                category: 'logic_error',
                title: 'Kept Finding',
                file: 'a.ts',
                lineRange: [1, 2],
                description: 'desc',
                supportingToolCalls: [],
                disproof: { attempted: false },
                verifiableClaims: [],
            });

            // This finding will be "dropped" by runSelfReflection (removed from store)
            const droppedId = 'finding-dropped';

            mockRunSelfReflection.mockImplementation(async (options) => {
                // Simulate dropping a finding by removing it from the store
                // (runSelfReflection does this internally for scores below threshold)
                options.findingStore.remove(droppedId);
                return {
                    scores: [
                        {
                            findingId: kept.id,
                            title: 'Kept Finding',
                            score: 8,
                            rationale: 'Solid evidence',
                        },
                        {
                            findingId: droppedId,
                            title: 'Dropped Finding',
                            score: 3,
                            rationale: 'Speculative',
                        },
                    ],
                    dropped: ['Dropped Finding'],
                    kept: ['Kept Finding'],
                };
            });

            // Add the "dropped" finding to the store so it exists initially
            (store as any).findings.set(droppedId, {
                id: droppedId,
                agentId: 'root',
                severity: 'LOW',
                category: 'style',
                title: 'Dropped Finding',
                file: 'b.ts',
                lineRange: [5, 6],
                description: 'will be dropped',
                supportingToolCalls: [],
                disproof: { attempted: false },
                verifiableClaims: [],
                timestamp: Date.now(),
                lspValidation: undefined,
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
            const f1 = store.record({
                agentId: 'root',
                severity: 'HIGH',
                category: 'logic_error',
                title: 'Finding A',
                file: 'a.ts',
                lineRange: [1, 2],
                description: 'desc',
                supportingToolCalls: [],
                disproof: { attempted: false },
                verifiableClaims: [],
            });
            const f2 = store.record({
                agentId: 'root',
                severity: 'MEDIUM',
                category: 'error_handling',
                title: 'Finding B',
                file: 'b.ts',
                lineRange: [3, 4],
                description: 'desc',
                supportingToolCalls: [],
                disproof: { attempted: false },
                verifiableClaims: [],
            });

            mockRunSelfReflection.mockResolvedValue({
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
            });

            const context = createMockContext({ findingStore: store });
            await step.execute(context);

            expect(context.selfReflectionScores).toHaveLength(2);
        });

        it('truncates conversation after self-reflection', async () => {
            const store = new FindingStore();
            store.record({
                agentId: 'root',
                severity: 'HIGH',
                category: 'logic_error',
                title: 'Bug',
                file: 'a.ts',
                lineRange: [1, 2],
                description: 'desc',
                supportingToolCalls: [],
                disproof: { attempted: false },
                verifiableClaims: [],
            });

            mockRunSelfReflection.mockResolvedValue({
                scores: [],
                dropped: [],
                kept: [],
            });

            const context = createMockContext({ findingStore: store });
            await step.execute(context);

            expect(
                context.conversationManager.truncateToMessageCount
            ).toHaveBeenCalledWith(5);
        });
    });
});
