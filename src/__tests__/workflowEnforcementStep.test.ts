import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkflowEnforcementStep } from '../services/pipeline/steps/workflowEnforcementStep';
import type { PipelineContext } from '../services/pipeline/pipelineTypes';
import { createMockCancellationToken } from './testUtils/mockFactories';
import { FindingStore } from '../sessions/findingStore';
import { ReasoningChain } from '../sessions/reasoningChain';

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
            toolCallCounts: new Map<string, number>(),
            investigatedFiles: new Set<string>(),
            completionReadiness: undefined,
            reasoningChain: new ReasoningChain(),
        } as any,
        parsedDiff: [],
        calibrationProfile: {
            investigationProtocol: {
                requiredToolsBeforeDone: [],
            },
        } as any,
        subagentExecutor: {} as any,
        conversationManager: {
            addUserMessage: vi.fn(),
            getHistory: vi.fn().mockReturnValue([]),
            clearHistory: vi.fn(),
            prependHistoryMessages: vi.fn(),
        } as any,
        conversationRunner: {
            run: vi.fn().mockResolvedValue('Workflow-completed review'),
            hitMaxIterations: false,
            wasCancelled: false,
            hitRateLimit: false,
            degraded: false,
            exitReason: undefined,
        } as any,
        systemPrompt: 'test prompt',
        availableTools: [
            { name: 'think_about_completion', getVSCodeTool: vi.fn() },
            { name: 'read_file', getVSCodeTool: vi.fn() },
            { name: 'submit_review', getVSCodeTool: vi.fn() },
            { name: 'retract_finding', getVSCodeTool: vi.fn() },
        ] as any,
        handler: {} as any,
        findingValidator: {} as any,
        ...overrides,
    };
}

describe('createWorkflowEnforcementStep', () => {
    let step: ReturnType<typeof createWorkflowEnforcementStep>;

    beforeEach(() => {
        step = createWorkflowEnforcementStep();
    });

    it('persists the latest review when workflow rerun completes successfully', async () => {
        const store = new FindingStore();
        store.record(makeFinding('Existing finding'));
        const context = createMockContext({
            findingStore: store,
            calibrationProfile: {
                investigationProtocol: {
                    requiredToolsBeforeDone: ['read_file'],
                },
            } as any,
        });

        await step.execute(context);

        expect(context.conversationRunner.run).toHaveBeenCalledOnce();
        expect(context.rewrittenAnalysis).toBe('Workflow-completed review');
        expect(context.lastCommittedReviewText).toBe(
            'Workflow-completed review'
        );
        expect(
            context.lastCommittedFindingStoreSnapshot?.findings.map(
                (finding) => finding.title
            )
        ).toEqual(['Existing finding']);
    });

    it('keeps the prior rewritten analysis when workflow rerun exits abnormally', async () => {
        const store = new FindingStore();
        const original = store.record(makeFinding('Existing finding'));
        const toolCallBudget = { value: 0 };
        const committedStore = new FindingStore();
        committedStore.record(makeFinding('Committed finding'));
        const context = createMockContext({
            rewrittenAnalysis: 'Existing review text',
            lastCommittedReviewText: 'Existing review text',
            lastCommittedFindingStoreSnapshot: committedStore.createSnapshot(),
            findingStore: store,
            executionContext: {
                cancellationToken: createMockCancellationToken(),
                toolCallCounts: new Map<string, number>(),
                investigatedFiles: new Set<string>(),
                completionReadiness: undefined,
                reasoningChain: new ReasoningChain(),
                toolExecutor: {
                    getToolCallCount: () => toolCallBudget.value,
                    setToolCallCount: (count: number) => {
                        toolCallBudget.value = count;
                    },
                },
            } as any,
            calibrationProfile: {
                investigationProtocol: {
                    requiredToolsBeforeDone: ['read_file'],
                },
            } as any,
            conversationRunner: {
                run: vi.fn().mockImplementation(async () => {
                    store.remove(original.id);
                    store.record(makeFinding('Transient workflow finding'));
                    toolCallBudget.value = 2;
                    context.executionContext.toolCallCounts.set('read_file', 1);
                    context.executionContext.investigatedFiles?.add(
                        'transient.ts'
                    );
                    context.executionContext.reasoningChain?.recordToolCall(
                        'read_file'
                    );
                    return 'Partial workflow review';
                }),
                hitMaxIterations: true,
                wasCancelled: false,
                hitRateLimit: false,
                degraded: false,
                exitReason: undefined,
            } as any,
        });

        const result = await step.execute(context);

        expect(context.rewrittenAnalysis).toBe('Existing review text');
        expect(store.size).toBe(1);
        expect(store.getById(original.id)?.title).toBe('Existing finding');
        expect(toolCallBudget.value).toBe(0);
        expect(context.executionContext.toolCallCounts.size).toBe(0);
        expect(context.executionContext.investigatedFiles?.size).toBe(0);
        expect(
            context.executionContext.reasoningChain?.getToolCallsSinceLastCheckpoint()
        ).toHaveLength(0);
        expect(result.budgetExhausted).toBe(true);
        expect(result.summary).toContain('hit iteration limit');
        expect(result.summary).toContain('Original review state preserved');
        expect(context.lastCommittedReviewText).toBe('Existing review text');
        expect(
            context.lastCommittedFindingStoreSnapshot?.findings.map(
                (finding) => finding.title
            )
        ).toEqual(['Committed finding']);
        expect(context.conversationManager.clearHistory).toHaveBeenCalledOnce();
        expect(
            context.conversationManager.prependHistoryMessages
        ).toHaveBeenCalledWith([]);
    });
});
