import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createZeroFindingChallengeStep } from '../services/pipeline/steps/zeroFindingChallengeStep';
import type { PipelineContext } from '../services/pipeline/pipelineTypes';
import { createMockCancellationToken } from './testUtils/mockFactories';
import { FindingStore } from '../sessions/findingStore';

function makeFinding(title: string) {
    return {
        agentId: 'root',
        severity: 'HIGH' as const,
        category: 'logic_error' as const,
        title,
        file: 'a.ts',
        lineRange: [1, 2] as [number, number],
        description: 'desc',
        affectedComponent: 'testComponent()',
        failureMechanism: 'runtime_exception' as const,
        supportingToolCalls: [],
        disproof: {
            attempted: false,
            method: 'not-attempted',
            result: 'No disproof attempt was made',
        },
        verifiableClaims: [],
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
            investigatedFiles: new Set<string>(),
        } as any,
        parsedDiff: Array.from({ length: 5 }, () => ({}) as any),
        calibrationProfile: {} as any,
        subagentExecutor: {} as any,
        conversationManager: {
            addUserMessage: vi.fn(),
            getHistory: vi.fn().mockReturnValue([]),
            clearHistory: vi.fn(),
            prependHistoryMessages: vi.fn(),
        } as any,
        conversationRunner: {
            run: vi.fn().mockResolvedValue('Zero-finding follow-up review'),
            hitMaxIterations: false,
            wasCancelled: false,
            hitRateLimit: false,
            degraded: false,
            exitReason: undefined,
        } as any,
        systemPrompt: 'test prompt',
        availableTools: [
            { name: 'get_file_diff', getVSCodeTool: vi.fn() },
            { name: 'find_symbol', getVSCodeTool: vi.fn() },
            { name: 'submit_review', getVSCodeTool: vi.fn() },
            { name: 'retract_finding', getVSCodeTool: vi.fn() },
        ] as any,
        handler: {} as any,
        findingValidator: {} as any,
        ...overrides,
    };
}

describe('createZeroFindingChallengeStep', () => {
    let step: ReturnType<typeof createZeroFindingChallengeStep>;

    beforeEach(() => {
        step = createZeroFindingChallengeStep();
    });

    it('persists the latest review when the challenge rerun completes successfully', async () => {
        const store = new FindingStore();
        const context = createMockContext({
            findingStore: store,
            conversationRunner: {
                run: vi.fn().mockImplementation(async () => {
                    store.record(makeFinding('Recovered finding'));
                    return 'Zero-finding follow-up review';
                }),
                hitMaxIterations: false,
                wasCancelled: false,
                hitRateLimit: false,
                degraded: false,
                exitReason: undefined,
            } as any,
        });

        await step.execute(context);

        expect(context.conversationRunner.run).toHaveBeenCalledOnce();
        expect(context.rewrittenAnalysis).toBe('Zero-finding follow-up review');
        expect(context.lastCommittedReviewText).toBe(
            'Zero-finding follow-up review'
        );
        expect(
            context.lastCommittedFindingStoreSnapshot?.findings.map(
                (finding) => finding.title
            )
        ).toEqual(['Recovered finding']);
    });

    it('keeps the prior rewritten analysis when the challenge ends without new findings', async () => {
        const store = new FindingStore();
        const committedStore = new FindingStore();
        const context = createMockContext({
            rewrittenAnalysis: 'Existing review text',
            lastCommittedReviewText: 'Existing review text',
            lastCommittedFindingStoreSnapshot: committedStore.createSnapshot(),
            findingStore: store,
            conversationRunner: {
                run: vi.fn().mockImplementation(async () => {
                    store.record(makeFinding('Transient challenge finding'));
                    context.executionContext.investigatedFiles?.add(
                        'transient.ts'
                    );
                    return 'Partial challenge review';
                }),
                hitMaxIterations: false,
                wasCancelled: false,
                hitRateLimit: true,
                degraded: false,
                exitReason: undefined,
            } as any,
        });

        const result = await step.execute(context);

        expect(context.rewrittenAnalysis).toBe('Existing review text');
        expect(context.executionContext.investigatedFiles?.size).toBe(0);
        expect(store.size).toBe(0);
        expect(result.summary).toContain('hit rate limit');
        expect(result.summary).toContain(
            'Original zero-finding state preserved'
        );
        expect(context.lastCommittedReviewText).toBe('Existing review text');
        expect(
            context.lastCommittedFindingStoreSnapshot?.findings.map(
                (finding) => finding.title
            )
        ).toEqual([]);
        expect(context.conversationManager.clearHistory).toHaveBeenCalledOnce();
        expect(
            context.conversationManager.prependHistoryMessages
        ).toHaveBeenCalledWith([]);
    });
});
