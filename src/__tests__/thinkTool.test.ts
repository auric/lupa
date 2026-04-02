import { describe, it, expect } from 'vitest';
import { ThinkTool } from '../tools/thinkTool';
import {
    createMockExecutionContext,
    createCancelledExecutionContext,
} from './testUtils/mockFactories';

describe('ThinkTool', () => {
    const tool = new ThinkTool();

    it('should have correct name and description', () => {
        expect(tool.name).toBe('think');
        expect(tool.description).toContain('REQUIRED reasoning checkpoint');
    });

    it('should return analysis guidance with topic heading', async () => {
        const context = createMockExecutionContext();

        const result = await tool.execute(
            {
                topic: 'auth changes in login.ts',
                analysis:
                    'Added null check before token validation. The early return might skip validation entirely.',
                identified_risks: [
                    'Token validation could be bypassed if null check returns early',
                    'Error path not tested',
                ],
                next_action:
                    'Use find_usages to check callers of validateToken',
            },
            context
        );

        expect(result.success).toBe(true);
        expect(result.data).toContain('auth changes in login.ts');
        expect(result.data).toContain('2 risk(s) to verify');
        expect(result.data).toContain(
            'Use find_usages to check callers of validateToken'
        );
    });

    it('should nudge hypothesis generation when no risks on early checkpoint', async () => {
        const context = createMockExecutionContext();

        const result = await tool.execute(
            {
                topic: 'refactoring handler.ts',
                analysis:
                    'Refactored to use async/await, no functional change detected.',
                identified_risks: [],
                next_action: 'Move to the next file in the diff',
            },
            context
        );

        expect(result.success).toBe(true);
        expect(result.data).toContain('No risks identified yet');
        expect(result.data).toContain('Generate at least 2 hypotheses');
        expect(result.data).toContain('Move to the next file');
    });

    it('should not nudge on later checkpoints (call count > 2) with no risks', async () => {
        const toolCallCounts = new Map<string, number>([['think', 3]]);
        const context = createMockExecutionContext({ toolCallCounts });

        const result = await tool.execute(
            {
                topic: "devil's advocate — is this really a bug?",
                analysis:
                    'Argued against the finding. The counter-argument wins.',
                identified_risks: [],
                next_action: 'Drop the finding',
            },
            context
        );

        expect(result.success).toBe(true);
        expect(result.data).toContain('No risks identified.');
        expect(result.data).not.toContain('Generate at least 2 hypotheses');
    });

    it('should still nudge when model uses synthesis-like topic on early checkpoint', async () => {
        // GPT-4.1 bypass: naming an early topic "evidence synthesis" to skip the nudge
        const toolCallCounts = new Map<string, number>([['think', 1]]);
        const context = createMockExecutionContext({ toolCallCounts });

        const result = await tool.execute(
            {
                topic: 'evidence synthesis and final assessment',
                analysis: 'Everything looks fine.',
                identified_risks: [],
                next_action: 'Move to next file',
            },
            context
        );

        expect(result.success).toBe(true);
        expect(result.data).toContain('No risks identified yet');
        expect(result.data).toContain('Generate at least 2 hypotheses');
    });

    it('should include risk count when risks present', async () => {
        const context = createMockExecutionContext();

        const result = await tool.execute(
            {
                topic: 'SQL query builder',
                analysis: 'Input is concatenated into SQL string directly',
                identified_risks: ['SQL injection via unsanitized input'],
                next_action: 'Record finding with record_finding tool',
            },
            context
        );

        expect(result.success).toBe(true);
        expect(result.data).toContain('1 risk(s) to verify');
    });

    it('should throw CancellationError when cancelled', async () => {
        const context = createCancelledExecutionContext();

        await expect(
            tool.execute(
                {
                    topic: 'test',
                    analysis: 'test',
                    identified_risks: [],
                    next_action: 'test',
                },
                context
            )
        ).rejects.toThrow();
    });

    it('should produce valid JSON schema from Zod', () => {
        const vsTool = tool.getVSCodeTool();
        expect(vsTool.name).toBe('think');
        expect(vsTool.inputSchema).toBeDefined();
    });

    it('should strip unexpected parameters (non-strict mode)', () => {
        const parsed = tool.schema.safeParse({
            topic: 'test',
            analysis: 'test analysis',
            identified_risks: [],
            next_action: 'continue',
            extra_field: 'not allowed',
        });
        expect(parsed.success).toBe(true);
    });

    it('should accept valid input with all required fields', () => {
        const parsed = tool.schema.safeParse({
            topic: 'auth changes',
            analysis: 'Reviewed the token handling logic',
            identified_risks: ['potential race condition'],
            next_action: 'check with find_usages',
        });
        expect(parsed.success).toBe(true);
    });

    it('should reject missing required fields', () => {
        const parsed = tool.schema.safeParse({});
        expect(parsed.success).toBe(false);
    });

    describe('ReasoningChain integration', () => {
        it('should record checkpoint in reasoning chain', async () => {
            const { ReasoningChain } =
                await import('../sessions/reasoningChain');
            const chain = new ReasoningChain();
            const context = createMockExecutionContext({
                reasoningChain: chain,
            });

            await tool.execute(
                {
                    topic: 'auth changes',
                    analysis: 'Reviewing auth module',
                    identified_risks: ['timing attack', 'null check'],
                    next_action: 'investigate with find_usages',
                },
                context
            );

            expect(chain.getCheckpointCount()).toBe(1);
            expect(chain.getAllHypotheses()).toHaveLength(2);
        });

        it('should warn about evidence gap when recording without investigation', async () => {
            const { ReasoningChain } =
                await import('../sessions/reasoningChain');
            const chain = new ReasoningChain();
            chain.addCheckpoint('previous', ['risk1']); // simulate a prior checkpoint
            const context = createMockExecutionContext({
                reasoningChain: chain,
                toolCallCounts: new Map([['think', 2]]),
            });

            const result = await tool.execute(
                {
                    topic: 'ready to record',
                    analysis: 'I found an issue',
                    identified_risks: [],
                    next_action: 'record_finding for the issue',
                },
                context
            );

            expect(result.data).toContain('EVIDENCE GAP');
        });

        it('should NOT warn about evidence gap when investigation tools were called', async () => {
            const { ReasoningChain } =
                await import('../sessions/reasoningChain');
            const chain = new ReasoningChain();
            chain.addCheckpoint('previous', []);
            chain.recordToolCall('find_usages');
            chain.recordToolCall('read_file');
            const context = createMockExecutionContext({
                reasoningChain: chain,
                toolCallCounts: new Map([['think', 2]]),
            });

            const result = await tool.execute(
                {
                    topic: 'ready to record',
                    analysis: 'Confirmed the issue with tools',
                    identified_risks: [],
                    next_action: 'record_finding for the issue',
                },
                context
            );

            expect(result.data).not.toContain('EVIDENCE GAP');
        });

        it('should warn about stale hypotheses from earlier checkpoints', async () => {
            const { ReasoningChain } =
                await import('../sessions/reasoningChain');
            const chain = new ReasoningChain();
            // Checkpoint 1: generate hypothesis
            chain.addCheckpoint('file1', ['forgotten risk']);
            // Checkpoint 2: no investigation
            chain.addCheckpoint('file2', []);

            const toolCallCounts = new Map<string, number>([['think', 3]]);
            const context = createMockExecutionContext({
                reasoningChain: chain,
                toolCallCounts,
            });

            // Checkpoint 3: should warn about stale hypothesis from checkpoint 1
            const result = await tool.execute(
                {
                    topic: 'synthesis',
                    analysis: 'Everything looks fine',
                    identified_risks: [],
                    next_action: 'submit review',
                },
                context
            );

            expect(result.data).toContain('STALE HYPOTHESES');
            expect(result.data).toContain('forgotten risk');
        });

        it('should show open hypothesis status for dismissive models', async () => {
            const { ReasoningChain } =
                await import('../sessions/reasoningChain');
            const chain = new ReasoningChain();
            chain.addCheckpoint('auth', ['timing attack', 'null check']);

            const toolCallCounts = new Map<string, number>([['think', 3]]);
            const context = createMockExecutionContext({
                reasoningChain: chain,
                toolCallCounts,
                calibrationProfile: {
                    ...createMockExecutionContext().calibrationProfile,
                    findingBias: 'dismissive' as const,
                    challengeMode: 'prosecution' as const,
                },
            });

            const result = await tool.execute(
                {
                    topic: 'progress check',
                    analysis: 'Some progress made',
                    identified_risks: [],
                    next_action: 'continue investigating',
                },
                context
            );

            expect(result.data).toContain('Open hypotheses');
            expect(result.data).toContain('timing attack');
        });

        it('should NOT show hypothesis status for balanced models', async () => {
            const { ReasoningChain } =
                await import('../sessions/reasoningChain');
            const chain = new ReasoningChain();
            chain.addCheckpoint('auth', ['timing attack']);

            const toolCallCounts = new Map<string, number>([['think', 3]]);
            const context = createMockExecutionContext({
                reasoningChain: chain,
                toolCallCounts,
            });

            const result = await tool.execute(
                {
                    topic: 'progress check',
                    analysis: 'Some progress',
                    identified_risks: [],
                    next_action: 'continue',
                },
                context
            );

            expect(result.data).not.toContain('Open hypotheses');
        });
    });
});
