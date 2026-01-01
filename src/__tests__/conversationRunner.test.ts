import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import {
    ConversationRunner,
    ConversationRunnerConfig,
    ToolCallHandler,
} from '../models/conversationRunner';
import { ConversationManager } from '../models/conversationManager';
import {
    CopilotModelManager,
    CopilotApiError,
} from '../models/copilotModelManager';
import { ToolExecutor } from '../models/toolExecutor';
import type { ITool } from '../tools/ITool';

// Mock dependencies
const createMockModelManager = (
    responses: Array<{ content: string | null; toolCalls?: any[] }>
) => {
    let callIndex = 0;
    return {
        sendRequest: vi.fn().mockImplementation(() => {
            const response = responses[callIndex] || {
                content: 'Default response',
                toolCalls: undefined,
            };
            callIndex++;
            return Promise.resolve(response);
        }),
        getCurrentModel: vi.fn().mockResolvedValue({
            id: 'test-model',
            maxInputTokens: 100000,
            countTokens: vi.fn().mockResolvedValue(100),
        }),
    } as unknown as CopilotModelManager;
};
const createMockToolExecutor = (
    results: Array<{
        name: string;
        success: boolean;
        result?: string;
        error?: string;
        metadata?: { isCompletion?: boolean };
    }> = []
) => {
    return {
        executeTools: vi
            .fn()
            .mockImplementation((requests: Array<{ name: string }>) => {
                // Return matching results in the same order as requests
                const matchedResults = requests.map((req) => {
                    const match = results.find((r) => r.name === req.name);
                    return (
                        match || {
                            name: req.name,
                            success: true,
                            result: 'Default response',
                        }
                    );
                });
                return Promise.resolve(matchedResults);
            }),
        getAvailableTools: vi.fn().mockReturnValue([]),
    } as unknown as ToolExecutor;
};

const createMockTool = (name: string): ITool => ({
    name,
    description: `Mock ${name} tool`,
    schema: {} as any,
    getVSCodeTool: () => ({
        name,
        description: `Mock ${name} tool`,
        inputSchema: {},
    }),
    execute: vi.fn().mockResolvedValue({ success: true, data: 'result' }),
});

const createCancellationToken = (
    cancelled = false
): vscode.CancellationToken => ({
    isCancellationRequested: cancelled,
    onCancellationRequested: vi.fn(),
});

describe('ConversationRunner', () => {
    let conversation: ConversationManager;

    beforeEach(() => {
        conversation = new ConversationManager();
    });

    describe('Basic Conversation Flow', () => {
        it('should return final response when no tool calls', async () => {
            const modelManager = createMockModelManager([
                { content: 'Final analysis result', toolCalls: undefined },
            ]);
            const toolExecutor = createMockToolExecutor();
            const runner = new ConversationRunner(modelManager, toolExecutor);

            const config: ConversationRunnerConfig = {
                systemPrompt: 'You are a helpful assistant',
                maxIterations: 10,
                tools: [],
            };

            conversation.addUserMessage('Analyze this code');
            const result = await runner.run(
                config,
                conversation,
                createCancellationToken()
            );

            expect(result).toBe('Final analysis result');
            expect(modelManager.sendRequest).toHaveBeenCalledTimes(1);
        });

        it('should handle empty content response', async () => {
            const modelManager = createMockModelManager([
                { content: null, toolCalls: undefined },
            ]);
            const toolExecutor = createMockToolExecutor();
            const runner = new ConversationRunner(modelManager, toolExecutor);

            const config: ConversationRunnerConfig = {
                systemPrompt: 'Test prompt',
                maxIterations: 10,
                tools: [],
            };

            const result = await runner.run(
                config,
                conversation,
                createCancellationToken()
            );

            expect(result).toContain('completed but no content');
        });
    });

    describe('Tool Call Handling', () => {
        it('should execute tool calls and continue conversation', async () => {
            const modelManager = createMockModelManager([
                {
                    content: 'Let me check that',
                    toolCalls: [
                        {
                            id: 'call_1',
                            function: {
                                name: 'find_symbol',
                                arguments: '{"name":"test"}',
                            },
                        },
                    ],
                },
                {
                    content: 'Based on the tool result, here is my analysis',
                    toolCalls: undefined,
                },
            ]);

            const toolExecutor = createMockToolExecutor([
                {
                    name: 'find_symbol',
                    success: true,
                    result: 'Symbol found at line 10',
                },
            ]);

            const runner = new ConversationRunner(modelManager, toolExecutor);

            const config: ConversationRunnerConfig = {
                systemPrompt: 'Test prompt',
                maxIterations: 10,
                tools: [createMockTool('find_symbol')],
            };

            const result = await runner.run(
                config,
                conversation,
                createCancellationToken()
            );

            expect(result).toBe(
                'Based on the tool result, here is my analysis'
            );
            expect(modelManager.sendRequest).toHaveBeenCalledTimes(2);
            expect(toolExecutor.executeTools).toHaveBeenCalledTimes(1);
        });

        it('should invoke onToolCallComplete handler', async () => {
            const modelManager = createMockModelManager([
                {
                    content: null,
                    toolCalls: [
                        {
                            id: 'call_1',
                            function: {
                                name: 'find_symbol',
                                arguments: '{"name":"test"}',
                            },
                        },
                    ],
                },
                { content: 'Done', toolCalls: undefined },
            ]);

            const toolExecutor = createMockToolExecutor([
                { name: 'find_symbol', success: true, result: 'Found it' },
            ]);

            const runner = new ConversationRunner(modelManager, toolExecutor);
            const onToolCallComplete = vi.fn();
            const onToolCallStart = vi.fn();

            const handler: ToolCallHandler = {
                onToolCallComplete,
                onToolCallStart,
            };

            const config: ConversationRunnerConfig = {
                systemPrompt: 'Test prompt',
                maxIterations: 10,
                tools: [createMockTool('find_symbol')],
            };

            await runner.run(
                config,
                conversation,
                createCancellationToken(),
                handler
            );

            expect(onToolCallStart).toHaveBeenCalledWith(
                'find_symbol',
                { name: 'test' },
                0,
                1
            );
            expect(onToolCallComplete).toHaveBeenCalledWith(
                'call_1',
                'find_symbol',
                { name: 'test' },
                'Found it',
                true,
                undefined,
                expect.any(Number),
                undefined // metadata
            );
        });

        it('should handle tool call errors', async () => {
            const modelManager = createMockModelManager([
                {
                    content: null,
                    toolCalls: [
                        {
                            id: 'call_1',
                            function: {
                                name: 'find_symbol',
                                arguments: '{"name":"test"}',
                            },
                        },
                    ],
                },
                { content: 'Analysis with error noted', toolCalls: undefined },
            ]);

            const toolExecutor = createMockToolExecutor([
                {
                    name: 'find_symbol',
                    success: false,
                    error: 'Symbol not found',
                },
            ]);

            const runner = new ConversationRunner(modelManager, toolExecutor);

            const config: ConversationRunnerConfig = {
                systemPrompt: 'Test prompt',
                maxIterations: 10,
                tools: [createMockTool('find_symbol')],
            };

            const result = await runner.run(
                config,
                conversation,
                createCancellationToken()
            );

            expect(result).toBe('Analysis with error noted');
            // Verify error was added to conversation
            const history = conversation.getHistory();
            const toolMessage = history.find((m) => m.role === 'tool');
            expect(toolMessage?.content).toContain('Error');
        });
    });

    describe('Iteration Limits', () => {
        it('should stop at max iterations', async () => {
            // Always return tool calls to keep the loop going
            const modelManager = createMockModelManager(
                Array(15).fill({
                    content: null,
                    toolCalls: [
                        {
                            id: 'call_1',
                            function: { name: 'find_symbol', arguments: '{}' },
                        },
                    ],
                })
            );

            const toolExecutor = createMockToolExecutor([
                { name: 'find_symbol', success: true, result: 'Found' },
            ]);

            const runner = new ConversationRunner(modelManager, toolExecutor);

            const config: ConversationRunnerConfig = {
                systemPrompt: 'Test prompt',
                maxIterations: 3,
                tools: [createMockTool('find_symbol')],
            };

            const result = await runner.run(
                config,
                conversation,
                createCancellationToken()
            );

            expect(result).toContain('maximum iterations');
            expect(modelManager.sendRequest).toHaveBeenCalledTimes(3);
        });
    });

    describe('Cancellation', () => {
        it('should handle cancellation request', async () => {
            const modelManager = createMockModelManager([
                { content: 'Result', toolCalls: undefined },
            ]);
            const toolExecutor = createMockToolExecutor();
            const runner = new ConversationRunner(modelManager, toolExecutor);

            const config: ConversationRunnerConfig = {
                systemPrompt: 'Test prompt',
                maxIterations: 10,
                tools: [],
            };

            const cancelledToken = createCancellationToken(true);
            const result = await runner.run(
                config,
                conversation,
                cancelledToken
            );

            expect(result).toContain('cancelled');
        });
    });

    describe('Error Handling', () => {
        it('should handle model errors and continue', async () => {
            let callCount = 0;
            const modelManager = {
                sendRequest: vi.fn().mockImplementation(() => {
                    callCount++;
                    if (callCount === 1) {
                        return Promise.reject(new Error('Temporary error'));
                    }
                    return Promise.resolve({
                        content: 'Recovered',
                        toolCalls: undefined,
                    });
                }),
                getCurrentModel: vi.fn().mockResolvedValue({
                    id: 'test-model',
                    maxInputTokens: 100000,
                    countTokens: vi.fn().mockResolvedValue(100),
                }),
            } as unknown as CopilotModelManager;

            const toolExecutor = createMockToolExecutor();
            const runner = new ConversationRunner(modelManager, toolExecutor);

            const config: ConversationRunnerConfig = {
                systemPrompt: 'Test prompt',
                maxIterations: 10,
                tools: [],
            };

            const result = await runner.run(
                config,
                conversation,
                createCancellationToken()
            );

            expect(result).toBe('Recovered');
        });

        it('should rethrow service unavailable errors', async () => {
            const modelManager = {
                sendRequest: vi
                    .fn()
                    .mockRejectedValue(new Error('service unavailable')),
                getCurrentModel: vi.fn().mockResolvedValue({
                    id: 'test-model',
                    maxInputTokens: 100000,
                    countTokens: vi.fn().mockResolvedValue(100),
                }),
            } as unknown as CopilotModelManager;

            const toolExecutor = createMockToolExecutor();
            const runner = new ConversationRunner(modelManager, toolExecutor);

            const config: ConversationRunnerConfig = {
                systemPrompt: 'Test prompt',
                maxIterations: 10,
                tools: [],
            };

            await expect(
                runner.run(config, conversation, createCancellationToken())
            ).rejects.toThrow('service unavailable');
        });

        it('should stop and rethrow unsupported model errors', async () => {
            const modelManager = {
                sendRequest: vi
                    .fn()
                    .mockRejectedValue(
                        new CopilotApiError(
                            'The selected Copilot model "foo" is not supported.',
                            'model_not_supported'
                        )
                    ),
                getCurrentModel: vi.fn().mockResolvedValue({
                    id: 'unsupported-model',
                    maxInputTokens: 100000,
                    countTokens: vi.fn().mockResolvedValue(100),
                }),
            } as unknown as CopilotModelManager;

            const toolExecutor = createMockToolExecutor();
            const runner = new ConversationRunner(modelManager, toolExecutor);

            const config: ConversationRunnerConfig = {
                systemPrompt: 'Test prompt',
                maxIterations: 10,
                tools: [],
            };

            await expect(
                runner.run(config, conversation, createCancellationToken())
            ).rejects.toThrow(/not supported/i);

            expect(modelManager.sendRequest).toHaveBeenCalledTimes(1);
        });
    });

    describe('Reset', () => {
        it('should reset internal state', () => {
            const modelManager = createMockModelManager([]);
            const toolExecutor = createMockToolExecutor();
            const runner = new ConversationRunner(modelManager, toolExecutor);

            // Just verify reset doesn't throw
            expect(() => runner.reset()).not.toThrow();
        });
    });

    describe('Explicit Completion and Nudging', () => {
        it('should nudge model when requiresExplicitCompletion is true and no tool calls', async () => {
            const modelManager = createMockModelManager([
                // First response: no tool calls, should trigger nudge
                {
                    content: 'Here is my initial analysis...',
                    toolCalls: undefined,
                },
                // Second response: model calls submit_review after nudge
                {
                    content: null,
                    toolCalls: [
                        {
                            id: 'call_submit',
                            function: {
                                name: 'submit_review',
                                arguments:
                                    '{"review_content":"Final review content"}',
                            },
                        },
                    ],
                },
            ]);

            const toolExecutor = createMockToolExecutor([
                {
                    name: 'submit_review',
                    success: true,
                    result: 'Final review content',
                    metadata: { isCompletion: true },
                },
            ]);

            const runner = new ConversationRunner(modelManager, toolExecutor);

            const config: ConversationRunnerConfig = {
                systemPrompt: 'Test prompt',
                maxIterations: 10,
                tools: [createMockTool('submit_review')],
                requiresExplicitCompletion: true,
            };

            const result = await runner.run(
                config,
                conversation,
                createCancellationToken()
            );

            expect(result).toBe('Final review content');
            expect(modelManager.sendRequest).toHaveBeenCalledTimes(2);

            // Verify nudge message was added to conversation
            const history = conversation.getHistory();
            const nudgeMessage = history.find(
                (m) => m.role === 'user' && m.content?.includes('submit_review')
            );
            expect(nudgeMessage).toBeDefined();
        });

        it('should accept response after MAX_COMPLETION_NUDGES when model never calls submit_review', async () => {
            // Model returns content without tool calls 3 times (exceeds MAX_COMPLETION_NUDGES=2)
            const modelManager = createMockModelManager([
                {
                    content: 'First attempt without submit_review',
                    toolCalls: undefined,
                },
                {
                    content: 'Second attempt without submit_review',
                    toolCalls: undefined,
                },
                {
                    content: 'Third attempt - final content',
                    toolCalls: undefined,
                },
            ]);

            const toolExecutor = createMockToolExecutor();
            const runner = new ConversationRunner(modelManager, toolExecutor);

            const config: ConversationRunnerConfig = {
                systemPrompt: 'Test prompt',
                maxIterations: 10,
                tools: [createMockTool('submit_review')],
                requiresExplicitCompletion: true,
            };

            const result = await runner.run(
                config,
                conversation,
                createCancellationToken()
            );

            // After 2 nudges (3rd response), should accept the response
            expect(result).toBe('Third attempt - final content');
            // 3 calls: initial + 2 nudges
            expect(modelManager.sendRequest).toHaveBeenCalledTimes(3);
        });

        it('should reset nudge counter when model calls any tool', async () => {
            const modelManager = createMockModelManager([
                // First: no tool calls, nudge count = 1
                { content: 'Let me think...', toolCalls: undefined },
                // Second: model calls a tool, nudge count resets to 0
                {
                    content: null,
                    toolCalls: [
                        {
                            id: 'call_1',
                            function: {
                                name: 'find_symbol',
                                arguments: '{"name":"test"}',
                            },
                        },
                    ],
                },
                // Third: no tool calls again, nudge count = 1 (not 2)
                { content: 'Still thinking...', toolCalls: undefined },
                // Fourth: finally submits
                {
                    content: null,
                    toolCalls: [
                        {
                            id: 'call_2',
                            function: {
                                name: 'submit_review',
                                arguments: '{"review_content":"Done"}',
                            },
                        },
                    ],
                },
            ]);

            const toolExecutor = createMockToolExecutor([
                { name: 'find_symbol', success: true, result: 'Found symbol' },
                {
                    name: 'submit_review',
                    success: true,
                    result: 'Done',
                    metadata: { isCompletion: true },
                },
            ]);

            const runner = new ConversationRunner(modelManager, toolExecutor);

            const config: ConversationRunnerConfig = {
                systemPrompt: 'Test prompt',
                maxIterations: 10,
                tools: [
                    createMockTool('find_symbol'),
                    createMockTool('submit_review'),
                ],
                requiresExplicitCompletion: true,
            };

            const result = await runner.run(
                config,
                conversation,
                createCancellationToken()
            );

            expect(result).toBe('Done');
            // All 4 requests should be made
            expect(modelManager.sendRequest).toHaveBeenCalledTimes(4);
        });

        it('should not nudge when requiresExplicitCompletion is false', async () => {
            const modelManager = createMockModelManager([
                // First response with content but no tool calls
                {
                    content: 'Here is my analysis without submit_review',
                    toolCalls: undefined,
                },
            ]);

            const toolExecutor = createMockToolExecutor();
            const runner = new ConversationRunner(modelManager, toolExecutor);

            const config: ConversationRunnerConfig = {
                systemPrompt: 'Test prompt',
                maxIterations: 10,
                tools: [createMockTool('find_symbol')],
                requiresExplicitCompletion: false, // Subagent/exploration behavior
            };

            const result = await runner.run(
                config,
                conversation,
                createCancellationToken()
            );

            // Should accept immediately without nudging
            expect(result).toBe('Here is my analysis without submit_review');
            expect(modelManager.sendRequest).toHaveBeenCalledTimes(1);

            // No nudge message should exist
            const history = conversation.getHistory();
            const nudgeMessage = history.find(
                (m) => m.role === 'user' && m.content?.includes('submit_review')
            );
            expect(nudgeMessage).toBeUndefined();
        });
    });
});
