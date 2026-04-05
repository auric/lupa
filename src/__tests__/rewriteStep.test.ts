import { vi, describe, it, expect, beforeEach } from 'vitest';
import { createRewriteStep } from '../services/pipeline/steps/rewriteStep';
import type { PipelineContext } from '../services/pipeline/pipelineTypes';
import { createMockCancellationToken } from './testUtils/mockFactories';

function createMockContext(
    overrides: Partial<PipelineContext> = {}
): PipelineContext {
    return {
        droppedTitles: [],
        downgradedTitles: [],
        additionalToolCallRecords: [],
        selfReflectionScores: [],
        rewrittenAnalysis: undefined,
        findingStore: { size: 0 } as any,
        toolCallRecords: [],
        executionContext: {
            cancellationToken: createMockCancellationToken(),
        } as any,
        parsedDiff: [],
        calibrationProfile: {} as any,
        subagentExecutor: {} as any,
        conversationManager: {
            addUserMessage: vi.fn(),
        } as any,
        conversationRunner: {
            run: vi.fn().mockResolvedValue('Rewritten review text'),
            hitMaxIterations: false,
            wasCancelled: false,
        } as any,
        systemPrompt: 'test prompt',
        availableTools: [
            { name: 'think', getVSCodeTool: vi.fn() },
            { name: 'submit_review', getVSCodeTool: vi.fn() },
            { name: 'retract_finding', getVSCodeTool: vi.fn() },
            { name: 'read_file', getVSCodeTool: vi.fn() },
        ] as any,
        handler: {} as any,
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
            });

            await step.execute(context);

            expect(context.rewrittenAnalysis).toBe('Rewritten review text');
            expect(context.conversationRunner.run).toHaveBeenCalled();
        });

        it('preserves original analysis when budget is exhausted', async () => {
            const context = createMockContext({
                droppedTitles: ['Finding A'],
                conversationRunner: {
                    run: vi.fn().mockResolvedValue('Partial garbage text'),
                    hitMaxIterations: true,
                    wasCancelled: false,
                } as any,
            });

            const result = await step.execute(context);

            expect(context.rewrittenAnalysis).toBeUndefined();
            expect(result.budgetExhausted).toBe(true);
            expect(result.summary).toContain('budget exhausted');
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
