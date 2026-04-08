import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PostAnalysisPipeline } from '../services/postAnalysisPipeline';
import { FindingStore } from '../sessions/findingStore';
import { createMockExecutionContext } from './testUtils/mockFactories';
import type { SelfReflectionScore } from '../services/selfReflectionScorer';
import type { RecordedFinding } from '../types/findingTypes';

// Mock pipeline runner so we can control what the pipeline "produces"
vi.mock('../services/pipeline/pipeline', () => ({
    runPipeline: vi.fn(
        async (_steps: unknown, context: Record<string, unknown>) => {
            // The mock mutator is attached by each test to simulate pipeline output
            const mutator = (
                context as {
                    __testMutator?: (ctx: Record<string, unknown>) => void;
                }
            ).__testMutator;
            if (mutator) {
                mutator(context);
            }
            return [];
        }
    ),
    createWorkflowEnforcementStep: vi.fn(),
    createZeroFindingChallengeStep: vi.fn(),
    createEvidenceAuditStep: vi.fn(),
    createFindingValidationStep: vi.fn(),
    createAdversarialVerificationStep: vi.fn(),
    createFindingScoringStep: vi.fn(),
    createSelfReflectionStep: vi.fn(),
    createRewriteStep: vi.fn(),
}));

vi.mock('../services/loggingService', () => ({
    Log: {
        info: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
    },
}));

function recordFinding(
    store: FindingStore,
    partial: Partial<
        Omit<RecordedFinding, 'id' | 'timestamp' | 'lspValidation'>
    >
): RecordedFinding {
    return store.record({
        agentId: partial.agentId ?? 'agent-1',
        severity: partial.severity ?? 'HIGH',
        category: partial.category ?? 'logic_error',
        title: partial.title ?? 'Default title',
        file: partial.file ?? 'src/index.ts',
        lineRange: partial.lineRange ?? [1, 5],
        description: partial.description ?? 'desc',
        affectedComponent: partial.affectedComponent ?? 'Component',
        failureMechanism: partial.failureMechanism ?? 'wrong_return_value',
        supportingToolCalls: partial.supportingToolCalls ?? ['read_file'],
        disproof: partial.disproof ?? {
            attempted: true,
            method: 'test',
            result: 'confirmed',
        },
        verifiableClaims: partial.verifiableClaims ?? [],
    });
}

function makeScore(
    findingId: string,
    title: string,
    score = 85
): SelfReflectionScore {
    return { findingId, title, score, rationale: 'test rationale' };
}

function createMinimalOptions(
    findingStore: FindingStore,
    mutator?: (ctx: Record<string, unknown>) => void
) {
    const execCtx = createMockExecutionContext();
    return {
        findingStore,
        toolCallRecords: [],
        initialAnalysisText: 'Initial review text.',
        executionContext: execCtx,
        parsedDiff: [],
        calibrationProfile: { name: 'test' } as never,
        subagentExecutor: {} as never,
        conversationManager: {} as never,
        conversationRunner: {} as never,
        systemPrompt: 'test',
        availableTools: [],
        handler: vi.fn(),
        __testMutator: mutator,
    };
}

describe('PostAnalysisPipeline score reconciliation', () => {
    let pipeline: PostAnalysisPipeline;

    beforeEach(() => {
        vi.clearAllMocks();
        pipeline = new PostAnalysisPipeline({} as never);
    });

    it('keeps scores for findings that exist in store when no rewrite happened', async () => {
        const store = new FindingStore();
        const f1 = recordFinding(store, { title: 'Null pointer dereference' });
        const f2 = recordFinding(store, { title: 'SQL injection risk' });

        const options = createMinimalOptions(store, (ctx) => {
            ctx.selfReflectionScores = [
                makeScore(f1.id, f1.title),
                makeScore(f2.id, f2.title),
            ];
        });

        const result = await pipeline.run(options as never);
        expect(result.selfReflectionScores).toHaveLength(2);
    });

    it('filters out scores for findings removed from the store', async () => {
        const store = new FindingStore();
        const f1 = recordFinding(store, { title: 'Null pointer dereference' });

        const options = createMinimalOptions(store, (ctx) => {
            ctx.selfReflectionScores = [
                makeScore(f1.id, f1.title),
                makeScore('finding-999', 'Removed finding title'),
            ];
        });

        const result = await pipeline.run(options as never);
        expect(result.selfReflectionScores).toHaveLength(1);
        expect(result.selfReflectionScores[0].findingId).toBe(f1.id);
    });

    it('filters scores when pipeline step removes findings from store', async () => {
        const store = new FindingStore();
        const f1 = recordFinding(store, { title: 'Null pointer dereference' });
        const f2 = recordFinding(store, { title: 'Memory exhaustion in loop' });

        const options = createMinimalOptions(store, (ctx) => {
            ctx.selfReflectionScores = [
                makeScore(f1.id, f1.title),
                makeScore(f2.id, f2.title),
            ];
            // Simulate a pipeline step removing f2 from the store
            store.remove(f2.id);
        });

        const result = await pipeline.run(options as never);
        expect(result.selfReflectionScores).toHaveLength(1);
        expect(result.selfReflectionScores[0].findingId).toBe(f1.id);
    });

    it('returns empty scores when all findings are removed from store', async () => {
        const store = new FindingStore();
        const f1 = recordFinding(store, { title: 'Null pointer dereference' });

        const options = createMinimalOptions(store, (ctx) => {
            ctx.selfReflectionScores = [makeScore(f1.id, f1.title)];
            // Simulate pipeline step removing all findings
            store.remove(f1.id);
        });

        const result = await pipeline.run(options as never);
        expect(result.selfReflectionScores).toHaveLength(0);
    });
});
