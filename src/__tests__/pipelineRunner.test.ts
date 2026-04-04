import { vi, describe, it, expect, beforeEach } from 'vitest';
import { runPipeline } from '../services/pipeline/pipelineRunner';
import type {
    PipelineStep,
    PipelineContext,
} from '../services/pipeline/pipelineTypes';
import { createMockCancellationToken } from './testUtils/mockFactories';

function createMockStep(overrides: Partial<PipelineStep> = {}): PipelineStep {
    return {
        name: 'test-step',
        label: 'Test Step',
        description: 'A test step',
        kind: 'programmatic',
        shouldRun: vi.fn().mockReturnValue(true),
        execute: vi.fn().mockResolvedValue({
            findingsDropped: [],
            findingsDowngraded: [],
            toolCallRecords: [],
        }),
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
        findingStore: {} as any,
        toolCallRecords: [],
        executionContext: {
            cancellationToken: createMockCancellationToken(),
        } as any,
        parsedDiff: [],
        calibrationProfile: {} as any,
        subagentExecutor: {} as any,
        conversationManager: {} as any,
        conversationRunner: {} as any,
        systemPrompt: '',
        availableTools: [],
        handler: {} as any,
        findingValidator: {} as any,
        ...overrides,
    };
}

describe('runPipeline', () => {
    let context: PipelineContext;

    beforeEach(() => {
        context = createMockContext();
    });

    it('executes steps in order', async () => {
        const stepA = createMockStep({ name: 'step-a', label: 'Step A' });
        const stepB = createMockStep({ name: 'step-b', label: 'Step B' });

        const records = await runPipeline([stepA, stepB], context);

        expect(records).toHaveLength(2);
        expect(records[0].name).toBe('step-a');
        expect(records[0].status).toBe('executed');
        expect(records[1].name).toBe('step-b');
        expect(records[1].status).toBe('executed');

        expect(stepA.execute).toHaveBeenCalledWith(context);
        expect(stepB.execute).toHaveBeenCalledWith(context);
    });

    it('skips steps where shouldRun returns false', async () => {
        const step = createMockStep({
            name: 'skip-me',
            label: 'Skip Me',
            shouldRun: vi.fn().mockReturnValue(false),
        });

        const records = await runPipeline([step], context);

        expect(records).toHaveLength(1);
        expect(records[0].status).toBe('skipped');
        expect(records[0].durationMs).toBe(0);
        expect(step.execute).not.toHaveBeenCalled();
    });

    it('marks remaining steps as cancelled when token is cancelled', async () => {
        const token = {
            onCancellationRequested: vi.fn(),
            isCancellationRequested: true,
        };
        context = createMockContext({
            executionContext: { cancellationToken: token } as any,
        });

        const stepA = createMockStep({
            name: 'a',
            label: 'A',
            kind: 'llm-conversation',
        });
        const stepB = createMockStep({
            name: 'b',
            label: 'B',
            kind: 'llm-conversation',
        });

        const records = await runPipeline([stepA, stepB], context);

        expect(records).toHaveLength(2);
        expect(records[0].status).toBe('cancelled');
        expect(records[0].durationMs).toBe(0);
        expect(records[1].status).toBe('cancelled');
        expect(records[1].durationMs).toBe(0);
        expect(stepA.execute).not.toHaveBeenCalled();
        expect(stepB.execute).not.toHaveBeenCalled();
    });

    it('cancellation mid-pipeline marks subsequent steps as cancelled', async () => {
        let cancelled = false;
        const token = {
            onCancellationRequested: vi.fn(),
        };
        Object.defineProperty(token, 'isCancellationRequested', {
            get: () => cancelled,
        });

        context = createMockContext({
            executionContext: { cancellationToken: token } as any,
        });

        const stepA = createMockStep({
            name: 'step-a',
            label: 'Step A',
            kind: 'llm-conversation',
            execute: vi.fn().mockImplementation(async () => {
                cancelled = true;
                return {
                    findingsDropped: [],
                    findingsDowngraded: [],
                    toolCallRecords: [],
                };
            }),
        });
        const stepB = createMockStep({
            name: 'step-b',
            label: 'Step B',
            kind: 'llm-conversation',
        });

        const records = await runPipeline([stepA, stepB], context);

        expect(records[0].status).toBe('executed');
        expect(records[1].status).toBe('cancelled');
        expect(stepB.execute).not.toHaveBeenCalled();
    });

    it('executes programmatic steps even when token is cancelled', async () => {
        const programmaticStep = createMockStep({
            name: 'programmatic-step',
            label: 'Programmatic',
            kind: 'programmatic',
        });
        const llmStep = createMockStep({
            name: 'llm-step',
            label: 'LLM Step',
            kind: 'llm-conversation',
        });

        // Pre-cancel the token
        let cancelled = true;
        const token = { onCancellationRequested: vi.fn() };
        Object.defineProperty(token, 'isCancellationRequested', {
            get: () => cancelled,
        });

        const context = createMockContext({
            executionContext: { cancellationToken: token } as any,
        });

        const records = await runPipeline([programmaticStep, llmStep], context);

        expect(records[0].status).toBe('executed'); // programmatic runs even when cancelled
        expect(records[1].status).toBe('cancelled'); // LLM is cancelled
        expect(programmaticStep.execute).toHaveBeenCalled();
        expect(llmStep.execute).not.toHaveBeenCalled();
    });

    it('accumulates dropped titles from step results', async () => {
        const step = createMockStep({
            execute: vi.fn().mockResolvedValue({
                findingsDropped: ['title-1', 'title-2'],
                findingsDowngraded: [],
                toolCallRecords: [],
            }),
        });

        await runPipeline([step], context);

        expect(context.droppedTitles).toEqual(['title-1', 'title-2']);
    });

    it('accumulates tool call records from step results', async () => {
        const record1 = { tool: 'a' };
        const record2 = { tool: 'b' };
        const step = createMockStep({
            execute: vi.fn().mockResolvedValue({
                findingsDropped: [],
                findingsDowngraded: [],
                toolCallRecords: [record1, record2],
            }),
        });

        await runPipeline([step], context);

        expect(context.additionalToolCallRecords).toEqual([record1, record2]);
    });

    it('records timing for executed steps and zero for skipped/cancelled', async () => {
        const executedStep = createMockStep({
            name: 'executed',
            label: 'Executed',
            execute: vi.fn().mockImplementation(
                () =>
                    new Promise((resolve) =>
                        setTimeout(
                            () =>
                                resolve({
                                    findingsDropped: [],
                                    findingsDowngraded: [],
                                    toolCallRecords: [],
                                }),
                            10
                        )
                    )
            ),
        });
        const skippedStep = createMockStep({
            name: 'skipped',
            label: 'Skipped',
            shouldRun: vi.fn().mockReturnValue(false),
        });

        const records = await runPipeline([executedStep, skippedStep], context);

        expect(records[0].status).toBe('executed');
        expect(records[0].durationMs).toBeGreaterThan(0);
        expect(records[1].status).toBe('skipped');
        expect(records[1].durationMs).toBe(0);
    });

    it('records failed status and continues to next step', async () => {
        const error = new Error('step blew up');
        const failingStep = createMockStep({
            name: 'failing-step',
            label: 'Failing Step',
            execute: vi.fn().mockRejectedValue(error),
        });
        const nextStep = createMockStep({
            name: 'next-step',
            label: 'Next Step',
        });

        const records = await runPipeline([failingStep, nextStep], context);

        expect(records).toHaveLength(2);
        expect(records[0].name).toBe('failing-step');
        expect(records[0].status).toBe('failed');
        expect(records[0].durationMs).toBeGreaterThanOrEqual(0);
        expect(records[1].name).toBe('next-step');
        expect(records[1].status).toBe('executed');
        expect(nextStep.execute).toHaveBeenCalled();
    });

    it('rethrows CancellationError from step.execute', async () => {
        const { CancellationError } = await import('vscode');
        const failingStep = createMockStep({
            name: 'failing-step',
            label: 'Failing Step',
            execute: vi.fn().mockRejectedValue(new CancellationError()),
        });

        await expect(runPipeline([failingStep], context)).rejects.toThrow();
    });
});
