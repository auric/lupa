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
            // No rewrite — rewrittenAnalysis stays undefined
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

    it('filters out scores for findings not mentioned in rewritten review', async () => {
        const store = new FindingStore();
        const f1 = recordFinding(store, { title: 'Null pointer dereference' });
        const f2 = recordFinding(store, { title: 'Memory exhaustion in loop' });

        const options = createMinimalOptions(store, (ctx) => {
            ctx.selfReflectionScores = [
                makeScore(f1.id, f1.title),
                makeScore(f2.id, f2.title),
            ];
            // Rewrite mentions f1 (null + dereference) but not f2
            ctx.rewrittenAnalysis =
                'The PR has a null pointer dereference bug in the handler that must be fixed.';
        });

        const result = await pipeline.run(options as never);
        expect(result.selfReflectionScores).toHaveLength(1);
        expect(result.selfReflectionScores[0].findingId).toBe(f1.id);
    });

    it('requires at least 2 title words to match in rewritten review', async () => {
        const store = new FindingStore();
        const f1 = recordFinding(store, { title: 'Memory exhaustion in loop' });

        const options = createMinimalOptions(store, (ctx) => {
            ctx.selfReflectionScores = [makeScore(f1.id, f1.title)];
            // Only "memory" appears — not enough (need 2 of [memory, exhaustion, loop])
            ctx.rewrittenAnalysis =
                'The PR has good memory management and no issues were found.';
        });

        const result = await pipeline.run(options as never);
        expect(result.selfReflectionScores).toHaveLength(0);
    });

    it('keeps score when at least 2 title words match in rewritten review', async () => {
        const store = new FindingStore();
        const f1 = recordFinding(store, { title: 'Memory exhaustion in loop' });

        const options = createMinimalOptions(store, (ctx) => {
            ctx.selfReflectionScores = [makeScore(f1.id, f1.title)];
            // "memory" + "loop" appear — 2 of 3 words match
            ctx.rewrittenAnalysis =
                'Found a memory issue caused by the infinite loop in the processor.';
        });

        const result = await pipeline.run(options as never);
        expect(result.selfReflectionScores).toHaveLength(1);
    });

    it('keeps score for single-word title when that word matches', async () => {
        const store = new FindingStore();
        const f1 = recordFinding(store, { title: 'Deadlock' });

        const options = createMinimalOptions(store, (ctx) => {
            ctx.selfReflectionScores = [makeScore(f1.id, f1.title)];
            // Single word title: min(2, 1) = 1, "deadlock" matches
            ctx.rewrittenAnalysis =
                'The code has a deadlock issue in the synchronization module.';
        });

        const result = await pipeline.run(options as never);
        expect(result.selfReflectionScores).toHaveLength(1);
    });

    it('ignores short words (< 3 chars) in title matching', async () => {
        const store = new FindingStore();
        // Title: "No XSS in form" — words >= 3 chars: ["xss", "form"]
        const f1 = recordFinding(store, { title: 'No XSS in form' });

        const options = createMinimalOptions(store, (ctx) => {
            ctx.selfReflectionScores = [makeScore(f1.id, f1.title)];
            // Both "xss" and "form" appear → 2 of 2 → passes min(2, 2) = 2
            ctx.rewrittenAnalysis =
                'Found an XSS vulnerability in the login form.';
        });

        const result = await pipeline.run(options as never);
        expect(result.selfReflectionScores).toHaveLength(1);
    });

    it('keeps score when all title words are below length threshold', async () => {
        const store = new FindingStore();
        // All words < 3 chars → titleWords is empty → heuristic can't validate → keeps score
        const f1 = recordFinding(store, { title: 'It is OK' });

        const options = createMinimalOptions(store, (ctx) => {
            ctx.selfReflectionScores = [makeScore(f1.id, f1.title)];
            ctx.rewrittenAnalysis =
                'The code looks fine with no issues detected.';
        });

        const result = await pipeline.run(options as never);
        expect(result.selfReflectionScores).toHaveLength(1);
    });
});
