import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
    const mockExecutor = {
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
        createScoped: vi.fn(),
        getExecutionContext: vi
            .fn()
            .mockReturnValue({ toolExecutor: undefined }),
    } as unknown as ToolExecutor;
    (mockExecutor as any).createScoped.mockReturnValue(mockExecutor);
    return mockExecutor;
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
    onCancellationRequested: vi.fn().mockReturnValue({ dispose: vi.fn() }),
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

    describe('afterToolCalls Hook', () => {
        it('should inject message when callback returns a string', async () => {
            const modelManager = createMockModelManager([
                {
                    content: null,
                    toolCalls: [
                        {
                            id: 'call_1',
                            function: {
                                name: 'run_subagent_batch',
                                arguments: '{"task":"review files"}',
                            },
                        },
                    ],
                },
                {
                    content: 'Final review after gap report',
                    toolCalls: undefined,
                },
            ]);

            const toolExecutor = createMockToolExecutor([
                {
                    name: 'run_subagent_batch',
                    success: true,
                    result: 'Subagent findings',
                },
            ]);

            const afterToolCalls = vi
                .fn()
                .mockReturnValue('Coverage gap: 3 files uncovered');

            const runner = new ConversationRunner(modelManager, toolExecutor);
            const config: ConversationRunnerConfig = {
                systemPrompt: 'Test prompt',
                maxIterations: 10,
                tools: [createMockTool('run_subagent_batch')],
                afterToolCalls,
            };

            await runner.run(config, conversation, createCancellationToken());

            expect(afterToolCalls).toHaveBeenCalledWith(['run_subagent_batch']);
            const history = conversation.getHistory();
            const injected = history.find(
                (m) => m.role === 'user' && m.content?.includes('Coverage gap')
            );
            expect(injected).toBeDefined();
        });

        it('should not inject message when callback returns undefined', async () => {
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
                {
                    content: 'Analysis complete',
                    toolCalls: undefined,
                },
            ]);

            const toolExecutor = createMockToolExecutor([
                {
                    name: 'find_symbol',
                    success: true,
                    result: 'Found symbol',
                },
            ]);

            const afterToolCalls = vi.fn().mockReturnValue(undefined);

            const runner = new ConversationRunner(modelManager, toolExecutor);
            const config: ConversationRunnerConfig = {
                systemPrompt: 'Test prompt',
                maxIterations: 10,
                tools: [createMockTool('find_symbol')],
                afterToolCalls,
            };

            await runner.run(config, conversation, createCancellationToken());

            expect(afterToolCalls).toHaveBeenCalledWith(['find_symbol']);
            const history = conversation.getHistory();
            const userMessages = history.filter((m) => m.role === 'user');
            // Only the initial user message should exist, no injected message
            expect(userMessages).toHaveLength(0);
        });

        it('should not call afterToolCalls when submit_review ends the loop', async () => {
            const modelManager = createMockModelManager([
                {
                    content: null,
                    toolCalls: [
                        {
                            id: 'call_1',
                            function: {
                                name: 'submit_review',
                                arguments: '{"review":"Final review text"}',
                            },
                        },
                    ],
                },
            ]);

            const toolExecutor = createMockToolExecutor([
                {
                    name: 'submit_review',
                    success: true,
                    result: 'Final review text',
                    metadata: { isCompletion: true },
                },
            ]);

            const afterToolCalls = vi.fn();

            const runner = new ConversationRunner(modelManager, toolExecutor);
            const config: ConversationRunnerConfig = {
                systemPrompt: 'Test prompt',
                maxIterations: 10,
                tools: [createMockTool('submit_review')],
                afterToolCalls,
            };

            await runner.run(config, conversation, createCancellationToken());

            // afterToolCalls should NOT be called because submit_review exits the loop before the hook
            expect(afterToolCalls).not.toHaveBeenCalled();
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

        it('should set hitMaxIterations flag when loop exhausts iterations', async () => {
            const modelManager = createMockModelManager(
                Array(5).fill({
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

            expect(runner.hitMaxIterations).toBe(false);

            const config: ConversationRunnerConfig = {
                systemPrompt: 'Test prompt',
                maxIterations: 2,
                tools: [createMockTool('find_symbol')],
            };

            await runner.run(config, conversation, createCancellationToken());

            expect(runner.hitMaxIterations).toBe(true);
        });

        it('should set hitMaxIterations flag when error occurs on last iteration', async () => {
            const modelManager = {
                sendRequest: vi
                    .fn()
                    .mockRejectedValue(
                        new Error('LLM error on final iteration')
                    ),
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
                maxIterations: 1,
                tools: [],
            };

            const result = await runner.run(
                config,
                conversation,
                createCancellationToken()
            );

            expect(runner.hitMaxIterations).toBe(true);
            expect(result).toContain('LLM error on final iteration');
        });

        it('should not set hitMaxIterations when conversation completes normally', async () => {
            const modelManager = createMockModelManager([
                { content: 'Final response', toolCalls: undefined },
            ]);
            const toolExecutor = createMockToolExecutor();
            const runner = new ConversationRunner(modelManager, toolExecutor);

            const config: ConversationRunnerConfig = {
                systemPrompt: 'Test prompt',
                maxIterations: 10,
                tools: [],
            };

            await runner.run(config, conversation, createCancellationToken());

            expect(runner.hitMaxIterations).toBe(false);
        });

        it('should reset hitMaxIterations flag on reset()', async () => {
            const modelManager = createMockModelManager(
                Array(5).fill({
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
                maxIterations: 1,
                tools: [createMockTool('find_symbol')],
            };

            await runner.run(config, conversation, createCancellationToken());
            expect(runner.hitMaxIterations).toBe(true);

            runner.reset();
            expect(runner.hitMaxIterations).toBe(false);
        });

        it('should reset hitRateLimit flag on reset()', async () => {
            vi.useFakeTimers();
            try {
                class ChatRateLimited extends Error {
                    constructor() {
                        super('Rate limited');
                        this.name = 'ChatRateLimited';
                    }
                }
                const modelManager = {
                    sendRequest: vi.fn().mockImplementation(() => {
                        return Promise.reject(new ChatRateLimited());
                    }),
                    getCurrentModel: vi.fn().mockResolvedValue({
                        id: 'test-model',
                        maxInputTokens: 100000,
                        countTokens: vi.fn().mockResolvedValue(100),
                    }),
                } as unknown as CopilotModelManager;
                const toolExecutor = createMockToolExecutor();
                const runner = new ConversationRunner(
                    modelManager,
                    toolExecutor
                );

                const config: ConversationRunnerConfig = {
                    systemPrompt: 'Test prompt',
                    maxIterations: 10,
                    tools: [],
                };

                conversation.addUserMessage('Test');
                const resultPromise = runner.run(
                    config,
                    conversation,
                    createCancellationToken()
                );

                for (let i = 0; i < 10; i++) {
                    await vi.advanceTimersByTimeAsync(60000);
                }

                await resultPromise;
                expect(runner.hitRateLimit).toBe(true);

                runner.reset();
                expect(runner.hitRateLimit).toBe(false);
            } finally {
                vi.useRealTimers();
            }
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

            expect(result).toBe('');
            expect(runner.wasCancelled).toBe(true);
        });

        it('should return cancellation message when non-CancellationError occurs with cancelled token', async () => {
            // Simulates: token cancelled by unrelated event, LLM throws a normal error
            const modelManager = {
                sendRequest: vi
                    .fn()
                    .mockRejectedValue(new Error('Connection reset')),
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

            // Token not cancelled initially, but becomes cancelled during sendRequest
            let firstCall = true;
            (modelManager.sendRequest as any).mockImplementation(() => {
                if (firstCall) {
                    firstCall = false;
                    // Return normally on first call so we get past the initial token check
                    return Promise.reject(new Error('Connection reset'));
                }
                return Promise.resolve({
                    content: 'Done',
                    toolCalls: undefined,
                });
            });

            // Use a token that is not initially cancelled
            const token: vscode.CancellationToken = {
                isCancellationRequested: false,
                onCancellationRequested: vi.fn(),
            };

            // Make isCancellationRequested become true after the error is thrown
            // by defining it as a getter that flips after first access
            let accessCount = 0;
            Object.defineProperty(token, 'isCancellationRequested', {
                get() {
                    accessCount++;
                    // First two checks (loop start + after response) return false
                    // Third check (in catch block) returns true
                    return accessCount > 2;
                },
            });

            const result = await runner.run(config, conversation, token);

            expect(result).toBe('');
            expect(runner.wasCancelled).toBe(true);
        });

        it('should set wasCancelled flag when token is pre-cancelled', async () => {
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

            expect(runner.wasCancelled).toBe(false);

            const cancelledToken = createCancellationToken(true);
            await runner.run(config, conversation, cancelledToken);

            expect(runner.wasCancelled).toBe(true);
        });

        it('should not set wasCancelled on normal completion', async () => {
            const modelManager = createMockModelManager([
                { content: 'Done', toolCalls: undefined },
            ]);
            const toolExecutor = createMockToolExecutor();
            const runner = new ConversationRunner(modelManager, toolExecutor);

            const config: ConversationRunnerConfig = {
                systemPrompt: 'Test prompt',
                maxIterations: 10,
                tools: [],
            };

            await runner.run(config, conversation, createCancellationToken());

            expect(runner.wasCancelled).toBe(false);
        });

        it('should reset wasCancelled flag on reset()', async () => {
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
            await runner.run(config, conversation, cancelledToken);
            expect(runner.wasCancelled).toBe(true);

            runner.reset();
            expect(runner.wasCancelled).toBe(false);
        });

        it('should detect cancellation after tool execution completes', async () => {
            // Simulates: token fires during tool execution, but tool completes normally
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
            ]);

            // Track cancellation state — becomes true during tool execution
            let cancelled = false;
            const token: vscode.CancellationToken = {
                get isCancellationRequested() {
                    return cancelled;
                },
                onCancellationRequested: vi.fn(),
            };

            const toolExecutor = {
                executeTools: vi.fn().mockImplementation(() => {
                    // Token fires during tool execution
                    cancelled = true;
                    return Promise.resolve([
                        {
                            name: 'find_symbol',
                            success: true,
                            result: 'Symbol found',
                        },
                    ]);
                }),
                getAvailableTools: vi.fn().mockReturnValue([]),
                createScoped: vi.fn(),
                getExecutionContext: vi
                    .fn()
                    .mockReturnValue({ toolExecutor: undefined }),
            } as unknown as ToolExecutor;
            (toolExecutor as any).createScoped.mockReturnValue(toolExecutor);

            const runner = new ConversationRunner(modelManager, toolExecutor);

            const config: ConversationRunnerConfig = {
                systemPrompt: 'Test prompt',
                maxIterations: 10,
                tools: [createMockTool('find_symbol')],
            };

            const result = await runner.run(config, conversation, token);

            expect(result).toBe('');
            expect(runner.wasCancelled).toBe(true);
            // Should not proceed to second LLM call
            expect(modelManager.sendRequest).toHaveBeenCalledTimes(1);
        });

        it('should detect cancellation after tool execution even with finalReview', async () => {
            // Simulates: submit_review completes but token fires during execution
            const modelManager = createMockModelManager([
                {
                    content: null,
                    toolCalls: [
                        {
                            id: 'call_submit',
                            function: {
                                name: 'submit_review',
                                arguments: '{"review_content":"Review"}',
                            },
                        },
                    ],
                },
            ]);

            let cancelled = false;
            const token: vscode.CancellationToken = {
                get isCancellationRequested() {
                    return cancelled;
                },
                onCancellationRequested: vi.fn(),
            };

            const toolExecutor = {
                executeTools: vi.fn().mockImplementation(() => {
                    cancelled = true;
                    return Promise.resolve([
                        {
                            name: 'submit_review',
                            success: true,
                            result: 'Review content',
                            metadata: { isCompletion: true },
                        },
                    ]);
                }),
                getAvailableTools: vi.fn().mockReturnValue([]),
                createScoped: vi.fn(),
                getExecutionContext: vi
                    .fn()
                    .mockReturnValue({ toolExecutor: undefined }),
            } as unknown as ToolExecutor;
            (toolExecutor as any).createScoped.mockReturnValue(toolExecutor);

            const runner = new ConversationRunner(modelManager, toolExecutor);

            const config: ConversationRunnerConfig = {
                systemPrompt: 'Test prompt',
                maxIterations: 10,
                tools: [createMockTool('submit_review')],
                requiresExplicitCompletion: true,
            };

            const result = await runner.run(config, conversation, token);

            // Cancellation takes priority over finalReview
            expect(result).toBe('');
            expect(runner.wasCancelled).toBe(true);
        });

        it('should detect cancellation in no-tool-calls path (subagent mode)', async () => {
            // Simulates: LLM returns content without tool calls, token fires during response processing
            let cancelled = false;
            const token: vscode.CancellationToken = {
                get isCancellationRequested() {
                    return cancelled;
                },
                onCancellationRequested: vi.fn(),
            };

            let sendRequestCount = 0;
            const modelManager = {
                sendRequest: vi.fn().mockImplementation(() => {
                    sendRequestCount++;
                    if (sendRequestCount === 1) {
                        // Token fires after sendRequest returns but before no-tool-calls processing
                        cancelled = true;
                        return Promise.resolve({
                            content: 'Here is my analysis',
                            toolCalls: undefined,
                        });
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
                requiresExplicitCompletion: false,
            };

            const result = await runner.run(config, conversation, token);

            // Should detect cancellation, not return the response content
            expect(result).toBe('');
            expect(runner.wasCancelled).toBe(true);
            expect(runner.hitMaxIterations).toBe(false);
        });

        it('should detect cancellation in no-tool-calls nudge path instead of hitMaxIterations', async () => {
            // Simulates: final iteration, LLM returns no tool calls, token fires during nudge processing
            // Without the fix, this would report hitMaxIterations instead of wasCancelled
            let cancelled = false;
            const token: vscode.CancellationToken = {
                get isCancellationRequested() {
                    return cancelled;
                },
                onCancellationRequested: vi.fn(),
            };

            const modelManager = {
                sendRequest: vi.fn().mockImplementation(() => {
                    // Token fires after sendRequest returns
                    cancelled = true;
                    return Promise.resolve({
                        content: 'Let me think about this...',
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
                maxIterations: 1,
                tools: [createMockTool('submit_review')],
                requiresExplicitCompletion: true,
            };

            const result = await runner.run(config, conversation, token);

            // Should detect cancellation, NOT report hitMaxIterations
            expect(result).toBe('');
            expect(runner.wasCancelled).toBe(true);
            expect(runner.hitMaxIterations).toBe(false);
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

        it('should stop on Anthropic BYOK system prompt error', async () => {
            // This is the raw error format from Anthropic API via VS Code LM API
            const anthropicError = new Error(
                '400 {"type":"error","error":{"type":"invalid_request_error","message":"system: text content blocks must be non-empty"},"request_id":"req_123"}'
            );

            const modelManager = {
                sendRequest: vi.fn().mockRejectedValue(anthropicError),
                getCurrentModel: vi.fn().mockResolvedValue({
                    id: 'anthropic-model',
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
            ).rejects.toThrow(/VS Code Language Model API/i);

            // Should stop after first attempt - fatal error
            expect(modelManager.sendRequest).toHaveBeenCalledTimes(1);
        });

        it('should stop on invalid_request_error from API', async () => {
            // Generic invalid_request_error (not specifically the system prompt issue)
            const apiError = new Error(
                '400 {"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: must be less than 8192"}}'
            );

            const modelManager = {
                sendRequest: vi.fn().mockRejectedValue(apiError),
                getCurrentModel: vi.fn().mockResolvedValue({
                    id: 'some-model',
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
            ).rejects.toThrow(/max_tokens/i);

            // Should stop after first attempt - fatal error
            expect(modelManager.sendRequest).toHaveBeenCalledTimes(1);
        });

        it('should stop on model_not_supported in raw error message', async () => {
            // Real API error format with nested error object
            const rawError = new Error(
                '400 {"error":{"code":"model_not_supported","message":"The model xyz is not supported"}}'
            );

            const modelManager = {
                sendRequest: vi.fn().mockRejectedValue(rawError),
                getCurrentModel: vi.fn().mockResolvedValue({
                    id: 'xyz-model',
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

        it('should stop on context overflow error', async () => {
            const contextError = new Error(
                'Request Failed: 400 {"error":{"message":"This model\'s maximum context length is 128000 tokens. However, you requested 131000 tokens.","code":"invalid_request_body"}}'
            );

            const modelManager = {
                sendRequest: vi.fn().mockRejectedValue(contextError),
                getCurrentModel: vi.fn().mockResolvedValue({
                    id: 'gpt-4.1',
                    maxInputTokens: 128000,
                    countTokens: vi.fn().mockResolvedValue(100),
                }),
            } as unknown as CopilotModelManager;

            const toolExecutor = createMockToolExecutor();
            const runner = new ConversationRunner(modelManager, toolExecutor);

            const config: ConversationRunnerConfig = {
                systemPrompt: 'Test prompt',
                maxIterations: 50,
                tools: [],
            };

            const result = await runner.run(
                config,
                conversation,
                createCancellationToken()
            );

            expect(result).toContain('context limit');
            expect(modelManager.sendRequest).toHaveBeenCalledTimes(1);
        });

        it('should stop on conversation corruption error', async () => {
            const corruptionError = new Error(
                'Request Failed: 400 {"error":{"message":"Invalid parameter: messages with role \'tool\' must be a response to a preceeding message with \'tool_calls\'.","code":"invalid_request_body"}}'
            );

            const modelManager = {
                sendRequest: vi.fn().mockRejectedValue(corruptionError),
                getCurrentModel: vi.fn().mockResolvedValue({
                    id: 'gpt-4.1',
                    maxInputTokens: 128000,
                    countTokens: vi.fn().mockResolvedValue(100),
                }),
            } as unknown as CopilotModelManager;

            const toolExecutor = createMockToolExecutor();
            const runner = new ConversationRunner(modelManager, toolExecutor);

            const config: ConversationRunnerConfig = {
                systemPrompt: 'Test prompt',
                maxIterations: 50,
                tools: [],
            };

            const result = await runner.run(
                config,
                conversation,
                createCancellationToken()
            );

            expect(result).toContain('corrupted');
            expect(modelManager.sendRequest).toHaveBeenCalledTimes(1);
        });

        it('should stop after consecutive errors to prevent infinite loops', async () => {
            const genericError = new Error('Some intermittent API error');

            const modelManager = {
                sendRequest: vi.fn().mockRejectedValue(genericError),
                getCurrentModel: vi.fn().mockResolvedValue({
                    id: 'gpt-4.1',
                    maxInputTokens: 128000,
                    countTokens: vi.fn().mockResolvedValue(100),
                }),
            } as unknown as CopilotModelManager;

            const toolExecutor = createMockToolExecutor();
            const runner = new ConversationRunner(modelManager, toolExecutor);

            const config: ConversationRunnerConfig = {
                systemPrompt: 'Test prompt',
                maxIterations: 50,
                tools: [],
            };

            const result = await runner.run(
                config,
                conversation,
                createCancellationToken()
            );

            expect(result).toContain('consecutive errors');
            // Should stop after MAX_CONSECUTIVE_ERRORS (3), not burn all 50
            expect(modelManager.sendRequest).toHaveBeenCalledTimes(3);
        });
    });

    describe('degraded flag', () => {
        it('should set degraded=true and exitReason on consecutive errors exit', async () => {
            const genericError = new Error('Persistent API failure');

            const modelManager = {
                sendRequest: vi.fn().mockRejectedValue(genericError),
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
                maxIterations: 50,
                tools: [],
            };

            const result = await runner.run(
                config,
                conversation,
                createCancellationToken()
            );

            expect(result).toContain('consecutive errors');
            expect(runner.degraded).toBe(true);
            expect(runner.exitReason).toBe('consecutive-errors');
        });

        it('should not set degraded on normal completion', async () => {
            const modelManager = createMockModelManager([
                { content: 'Final response', toolCalls: undefined },
            ]);
            const toolExecutor = createMockToolExecutor();
            const runner = new ConversationRunner(modelManager, toolExecutor);

            const config: ConversationRunnerConfig = {
                systemPrompt: 'Test prompt',
                maxIterations: 10,
                tools: [],
            };

            await runner.run(config, conversation, createCancellationToken());

            expect(runner.degraded).toBe(false);
            expect(runner.exitReason).toBeUndefined();
        });

        it('should reset degraded flag on new run()', async () => {
            const genericError = new Error('Persistent API failure');

            let callCount = 0;
            const modelManager = {
                sendRequest: vi.fn().mockImplementation(() => {
                    callCount++;
                    // First 3 calls: errors (triggers consecutive-errors exit)
                    if (callCount <= 3) {
                        return Promise.reject(genericError);
                    }
                    // After reset, return normal response
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
                maxIterations: 50,
                tools: [],
            };

            // First run hits degraded exit
            await runner.run(config, conversation, createCancellationToken());
            expect(runner.degraded).toBe(true);

            // Second run completes normally — degraded is reset at start of run()
            const conversation2 = new ConversationManager();
            await runner.run(config, conversation2, createCancellationToken());
            expect(runner.degraded).toBe(false);
            expect(runner.exitReason).toBeUndefined();
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
        it('should send soft continue on first no-tool-call, then nudge submit_review on second', async () => {
            const modelManager = createMockModelManager([
                // First response: no tool calls, should trigger soft continue
                {
                    content: 'Here is my initial analysis...',
                    toolCalls: undefined,
                },
                // Second response: model calls submit_review after soft continue
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

            // Verify soft continue message was added (not the firm nudge)
            const history = conversation.getHistory();
            const softContinue = history.find(
                (m) =>
                    m.role === 'user' &&
                    m.content?.includes('Continue investigating')
            );
            expect(softContinue).toBeDefined();
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

        it('should extract review from malformed tool call when nudges exhausted', async () => {
            // Model outputs JSON-formatted tool call in text instead of actual tool call
            const malformedContent = `Calling submit_review with the final review.

\`\`\`json
{
  "review_content": "## Summary\\n> **TL;DR**: Extracted review content with detailed findings and recommendations."
}
\`\`\``;

            const modelManager = createMockModelManager([
                { content: 'First attempt', toolCalls: undefined },
                { content: 'Second attempt', toolCalls: undefined },
                { content: malformedContent, toolCalls: undefined },
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

            // Should extract the review_content from the malformed JSON
            expect(result).toBe(
                '## Summary\n> **TL;DR**: Extracted review content with detailed findings and recommendations.'
            );
            expect(modelManager.sendRequest).toHaveBeenCalledTimes(3);
        });
    });

    describe('beforeAcceptingResponse Callback', () => {
        it('should inject nudge message when callback returns a string', async () => {
            const modelManager = createMockModelManager([
                // First: model calls get_file_diff
                {
                    content: null,
                    toolCalls: [
                        {
                            id: 'call_1',
                            function: {
                                name: 'get_file_diff',
                                arguments: '{"file":"test.ts"}',
                            },
                        },
                    ],
                },
                // Second: model tries to finish without deeper investigation
                {
                    content: 'Here are my findings from the diff...',
                    toolCalls: undefined,
                },
                // Third: after nudge, model uses find_symbol
                {
                    content: null,
                    toolCalls: [
                        {
                            id: 'call_2',
                            function: {
                                name: 'find_symbol',
                                arguments: '{"name":"myFunc"}',
                            },
                        },
                    ],
                },
                // Fourth: model finishes with deeper analysis
                {
                    content: 'Deep analysis with symbol information.',
                    toolCalls: undefined,
                },
            ]);

            const toolExecutor = createMockToolExecutor([
                {
                    name: 'get_file_diff',
                    success: true,
                    result: 'diff content',
                },
                {
                    name: 'find_symbol',
                    success: true,
                    result: 'symbol info',
                },
            ]);

            const runner = new ConversationRunner(modelManager, toolExecutor);

            // Capture snapshots of toolNamesCalled at each invocation (it's a shared Set)
            const capturedToolNames: Set<string>[] = [];
            const beforeAcceptingResponse = vi
                .fn()
                .mockImplementation((toolNames: Set<string>) => {
                    capturedToolNames.push(new Set(toolNames));
                    if (capturedToolNames.length === 1) {
                        return 'You only read the diff. Use find_symbol to investigate deeper.';
                    }
                    return undefined;
                });

            const config: ConversationRunnerConfig = {
                systemPrompt: 'Test prompt',
                maxIterations: 10,
                tools: [
                    createMockTool('get_file_diff'),
                    createMockTool('find_symbol'),
                ],
                requiresExplicitCompletion: false,
                beforeAcceptingResponse,
            };

            const result = await runner.run(
                config,
                conversation,
                createCancellationToken()
            );

            expect(result).toBe('Deep analysis with symbol information.');
            expect(beforeAcceptingResponse).toHaveBeenCalledTimes(2);
            // First call: only get_file_diff was used
            expect(capturedToolNames[0]).toEqual(new Set(['get_file_diff']));
            // Second call: both tools were used
            expect(capturedToolNames[1]).toEqual(
                new Set(['get_file_diff', 'find_symbol'])
            );
            // Verify nudge message was injected
            const history = conversation.getHistory();
            const nudge = history.find(
                (m) =>
                    m.role === 'user' && m.content?.includes('Use find_symbol')
            );
            expect(nudge).toBeDefined();
        });

        it('should accept response when callback returns undefined', async () => {
            const modelManager = createMockModelManager([
                // Model calls find_symbol (a deep investigation tool)
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
                // Model finishes
                {
                    content: 'Analysis with proper investigation.',
                    toolCalls: undefined,
                },
            ]);

            const toolExecutor = createMockToolExecutor([
                {
                    name: 'find_symbol',
                    success: true,
                    result: 'symbol info',
                },
            ]);

            const runner = new ConversationRunner(modelManager, toolExecutor);

            // Callback returns undefined — investigation was sufficient
            const beforeAcceptingResponse = vi.fn().mockReturnValue(undefined);

            const config: ConversationRunnerConfig = {
                systemPrompt: 'Test prompt',
                maxIterations: 10,
                tools: [createMockTool('find_symbol')],
                requiresExplicitCompletion: false,
                beforeAcceptingResponse,
            };

            const result = await runner.run(
                config,
                conversation,
                createCancellationToken()
            );

            expect(result).toBe('Analysis with proper investigation.');
            expect(beforeAcceptingResponse).toHaveBeenCalledTimes(1);
            expect(modelManager.sendRequest).toHaveBeenCalledTimes(2);
        });

        it('should not call beforeAcceptingResponse when requiresExplicitCompletion is true', async () => {
            const modelManager = createMockModelManager([
                // No tool calls — explicit completion mode nudges submit_review instead
                {
                    content: 'Attempt without submit_review',
                    toolCalls: undefined,
                },
                {
                    content: 'Second attempt',
                    toolCalls: undefined,
                },
                {
                    content: 'Third attempt - accepted after max nudges',
                    toolCalls: undefined,
                },
            ]);

            const toolExecutor = createMockToolExecutor();
            const runner = new ConversationRunner(modelManager, toolExecutor);

            const beforeAcceptingResponse = vi.fn();

            const config: ConversationRunnerConfig = {
                systemPrompt: 'Test prompt',
                maxIterations: 10,
                tools: [createMockTool('submit_review')],
                requiresExplicitCompletion: true,
                beforeAcceptingResponse,
            };

            await runner.run(config, conversation, createCancellationToken());

            // beforeAcceptingResponse should never be called in explicit completion mode
            expect(beforeAcceptingResponse).not.toHaveBeenCalled();
        });

        it('should pass correct iteration and maxIterations to callback', async () => {
            const modelManager = createMockModelManager([
                // First: tool call
                {
                    content: null,
                    toolCalls: [
                        {
                            id: 'call_1',
                            function: {
                                name: 'get_file_diff',
                                arguments: '{"file":"a.ts"}',
                            },
                        },
                    ],
                },
                // Second: no tool calls — triggers callback
                {
                    content: 'Done after one tool call.',
                    toolCalls: undefined,
                },
            ]);

            const toolExecutor = createMockToolExecutor([
                {
                    name: 'get_file_diff',
                    success: true,
                    result: 'diff',
                },
            ]);

            const runner = new ConversationRunner(modelManager, toolExecutor);

            const beforeAcceptingResponse = vi.fn().mockReturnValue(undefined);

            const config: ConversationRunnerConfig = {
                systemPrompt: 'Test prompt',
                maxIterations: 20,
                tools: [createMockTool('get_file_diff')],
                requiresExplicitCompletion: false,
                beforeAcceptingResponse,
            };

            await runner.run(config, conversation, createCancellationToken());

            // Callback should receive iteration=2 (second iteration) and maxIterations=20
            expect(beforeAcceptingResponse).toHaveBeenCalledWith(
                expect.any(Set),
                2,
                20
            );
        });
    });

    describe('Wind-down Mechanism', () => {
        it('should force text response on last iteration for non-explicit-completion', async () => {
            // 3 iterations: first 2 make tool calls, third is forced text
            let callIndex = 0;
            const modelManager = createMockModelManager(
                Array(3).fill({
                    content: null,
                    toolCalls: [
                        {
                            id: 'call_1',
                            function: { name: 'find_symbol', arguments: '{}' },
                        },
                    ],
                })
            );
            // Override to return text on 3rd call (when tools are empty)
            (
                modelManager.sendRequest as ReturnType<typeof vi.fn>
            ).mockImplementation((request: any) => {
                callIndex++;
                if (request.tools.length === 0) {
                    return Promise.resolve({
                        content: 'Final findings from subagent',
                        toolCalls: undefined,
                    });
                }
                return Promise.resolve({
                    content: null,
                    toolCalls: [
                        {
                            id: `call_${callIndex}`,
                            function: {
                                name: 'find_symbol',
                                arguments: '{}',
                            },
                        },
                    ],
                });
            });

            const toolExecutor = createMockToolExecutor([
                { name: 'find_symbol', success: true, result: 'Found' },
            ]);

            const runner = new ConversationRunner(modelManager, toolExecutor);

            const config: ConversationRunnerConfig = {
                systemPrompt: 'Test prompt',
                maxIterations: 3,
                tools: [createMockTool('find_symbol')],
                // No requiresExplicitCompletion — subagent mode
            };

            const result = await runner.run(
                config,
                conversation,
                createCancellationToken()
            );

            expect(result).toBe('Final findings from subagent');
            expect(runner.hitMaxIterations).toBe(false);
        });

        it('should NOT force text on last iteration when requiresExplicitCompletion is true', async () => {
            // Main analysis with requiresExplicitCompletion should keep tools on last iteration
            const modelManager = createMockModelManager(
                Array(3).fill({
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
                maxIterations: 2,
                tools: [createMockTool('find_symbol')],
                requiresExplicitCompletion: true,
            };

            await runner.run(config, conversation, createCancellationToken());

            // All sendRequest calls should have tools
            const calls = (modelManager.sendRequest as ReturnType<typeof vi.fn>)
                .mock.calls;
            for (const call of calls) {
                expect(call[0].tools.length).toBeGreaterThan(0);
            }
        });

        it('should return last substantive response when hitting max iterations', async () => {
            let callCount = 0;
            const modelManager = {
                sendRequest: vi.fn().mockImplementation(() => {
                    callCount++;
                    // Second call has substantive content alongside tool calls
                    if (callCount === 2) {
                        return Promise.resolve({
                            content:
                                'I found a critical security issue in the authentication module that needs immediate attention.',
                            toolCalls: [
                                {
                                    id: `call_${callCount}`,
                                    function: {
                                        name: 'find_symbol',
                                        arguments: '{}',
                                    },
                                },
                            ],
                        });
                    }
                    return Promise.resolve({
                        content: null,
                        toolCalls: [
                            {
                                id: `call_${callCount}`,
                                function: {
                                    name: 'find_symbol',
                                    arguments: '{}',
                                },
                            },
                        ],
                    });
                }),
                getCurrentModel: vi.fn().mockResolvedValue({
                    id: 'test-model',
                    maxInputTokens: 100000,
                    countTokens: vi.fn().mockResolvedValue(100),
                }),
            } as unknown as CopilotModelManager;

            const toolExecutor = createMockToolExecutor([
                { name: 'find_symbol', success: true, result: 'Found' },
            ]);

            const runner = new ConversationRunner(modelManager, toolExecutor);

            const config: ConversationRunnerConfig = {
                systemPrompt: 'Test prompt',
                maxIterations: 3,
                tools: [createMockTool('find_symbol')],
                requiresExplicitCompletion: true,
            };

            const result = await runner.run(
                config,
                conversation,
                createCancellationToken()
            );

            // Should return the substantive response from call #2, not generic message
            expect(result).toContain('critical security issue');
            expect(runner.hitMaxIterations).toBe(true);
        });

        it('should inject wind-down user message on last iteration', async () => {
            const addUserMessageSpy = vi.spyOn(conversation, 'addUserMessage');

            let callCount = 0;
            const modelManager = {
                sendRequest: vi.fn().mockImplementation((request: any) => {
                    callCount++;
                    if (request.tools.length === 0) {
                        return Promise.resolve({
                            content: 'My final analysis',
                            toolCalls: undefined,
                        });
                    }
                    return Promise.resolve({
                        content: null,
                        toolCalls: [
                            {
                                id: `call_${callCount}`,
                                function: {
                                    name: 'find_symbol',
                                    arguments: '{}',
                                },
                            },
                        ],
                    });
                }),
                getCurrentModel: vi.fn().mockResolvedValue({
                    id: 'test-model',
                    maxInputTokens: 100000,
                    countTokens: vi.fn().mockResolvedValue(100),
                }),
            } as unknown as CopilotModelManager;

            const toolExecutor = createMockToolExecutor([
                { name: 'find_symbol', success: true, result: 'Found' },
            ]);

            const runner = new ConversationRunner(modelManager, toolExecutor);

            const config: ConversationRunnerConfig = {
                systemPrompt: 'Test prompt',
                maxIterations: 2,
                tools: [createMockTool('find_symbol')],
            };

            await runner.run(config, conversation, createCancellationToken());

            // Check that a wind-down message was injected
            const windDownCalls = addUserMessageSpy.mock.calls.filter(
                (call) =>
                    typeof call[0] === 'string' &&
                    call[0].includes('final iteration')
            );
            expect(windDownCalls.length).toBe(1);
        });

        it('should inject urgent wind-down nudge at ~92% of budget', async () => {
            const addUserMessageSpy = vi.spyOn(conversation, 'addUserMessage');

            // Use maxIterations=20 so urgent nudge (92% = iter 18) fires
            // before final buffer (iter 19-20).
            // windDownIteration = floor(20 * 0.85) = 17
            // urgentWindDownIteration = floor(20 * 0.92) = 18
            // finalBufferStart = 20 - 2 + 1 = 19
            let callCount = 0;
            const modelManager = {
                sendRequest: vi.fn().mockImplementation((request: any) => {
                    callCount++;
                    if (request.tools.length === 0) {
                        return Promise.resolve({
                            content: 'My final analysis',
                            toolCalls: undefined,
                        });
                    }
                    return Promise.resolve({
                        content: null,
                        toolCalls: [
                            {
                                id: `call_${callCount}`,
                                function: {
                                    name: 'find_symbol',
                                    arguments: '{}',
                                },
                            },
                        ],
                    });
                }),
                getCurrentModel: vi.fn().mockResolvedValue({
                    id: 'test-model',
                    maxInputTokens: 100000,
                    countTokens: vi.fn().mockResolvedValue(100),
                }),
            } as unknown as CopilotModelManager;

            const toolExecutor = createMockToolExecutor([
                { name: 'find_symbol', success: true, result: 'Found' },
            ]);

            const runner = new ConversationRunner(modelManager, toolExecutor);

            const config: ConversationRunnerConfig = {
                systemPrompt: 'Test prompt',
                maxIterations: 20,
                tools: [createMockTool('find_symbol')],
            };

            await runner.run(config, conversation, createCancellationToken());

            // Should have the 85% budget check nudge
            const budgetNudges = addUserMessageSpy.mock.calls.filter(
                (call) =>
                    typeof call[0] === 'string' &&
                    call[0].includes('Budget check')
            );
            expect(budgetNudges.length).toBe(1);

            // Should have the urgent 92% nudge
            const urgentNudges = addUserMessageSpy.mock.calls.filter(
                (call) =>
                    typeof call[0] === 'string' && call[0].includes('URGENT')
            );
            expect(urgentNudges.length).toBe(1);

            // Should have the final iteration wrap-up
            const finalNudges = addUserMessageSpy.mock.calls.filter(
                (call) =>
                    typeof call[0] === 'string' &&
                    call[0].includes('final iteration')
            );
            expect(finalNudges.length).toBe(1);
        });

        it('should remove tools for last 2 iterations when maxIterations > 10', async () => {
            // maxIterations=12: finalBufferStart = 12 - 2 + 1 = 11
            // Tools should be empty at iterations 11 and 12
            const toolRequestCounts: {
                iteration: number;
                toolCount: number;
            }[] = [];
            let callCount = 0;

            const modelManager = {
                sendRequest: vi.fn().mockImplementation((request: any) => {
                    callCount++;
                    toolRequestCounts.push({
                        iteration: callCount,
                        toolCount: request.tools.length,
                    });
                    if (request.tools.length === 0) {
                        return Promise.resolve({
                            content: 'Final findings',
                            toolCalls: undefined,
                        });
                    }
                    return Promise.resolve({
                        content: null,
                        toolCalls: [
                            {
                                id: `call_${callCount}`,
                                function: {
                                    name: 'find_symbol',
                                    arguments: '{}',
                                },
                            },
                        ],
                    });
                }),
                getCurrentModel: vi.fn().mockResolvedValue({
                    id: 'test-model',
                    maxInputTokens: 100000,
                    countTokens: vi.fn().mockResolvedValue(100),
                }),
            } as unknown as CopilotModelManager;

            const toolExecutor = createMockToolExecutor([
                { name: 'find_symbol', success: true, result: 'Found' },
            ]);

            const runner = new ConversationRunner(modelManager, toolExecutor);

            const config: ConversationRunnerConfig = {
                systemPrompt: 'Test prompt',
                maxIterations: 12,
                tools: [createMockTool('find_symbol')],
            };

            await runner.run(config, conversation, createCancellationToken());

            // Iterations 1-10 should have tools, iteration 11 should have none
            // (model returns text at iter 11, ending the conversation)
            const withoutTools = toolRequestCounts.filter(
                (r) => r.toolCount === 0
            );
            expect(withoutTools.length).toBeGreaterThanOrEqual(1);
            expect(withoutTools[0].iteration).toBe(11); // finalBufferStart
        });

        it('should NOT expand final buffer when maxIterations <= 10', async () => {
            // maxIterations=3: finalBufferStart = 3 (last iteration only)
            const toolRequestCounts: {
                iteration: number;
                toolCount: number;
            }[] = [];
            let callCount = 0;

            const modelManager = {
                sendRequest: vi.fn().mockImplementation((request: any) => {
                    callCount++;
                    toolRequestCounts.push({
                        iteration: callCount,
                        toolCount: request.tools.length,
                    });
                    if (request.tools.length === 0) {
                        return Promise.resolve({
                            content: 'Final findings',
                            toolCalls: undefined,
                        });
                    }
                    return Promise.resolve({
                        content: null,
                        toolCalls: [
                            {
                                id: `call_${callCount}`,
                                function: {
                                    name: 'find_symbol',
                                    arguments: '{}',
                                },
                            },
                        ],
                    });
                }),
                getCurrentModel: vi.fn().mockResolvedValue({
                    id: 'test-model',
                    maxInputTokens: 100000,
                    countTokens: vi.fn().mockResolvedValue(100),
                }),
            } as unknown as CopilotModelManager;

            const toolExecutor = createMockToolExecutor([
                { name: 'find_symbol', success: true, result: 'Found' },
            ]);

            const runner = new ConversationRunner(modelManager, toolExecutor);

            const config: ConversationRunnerConfig = {
                systemPrompt: 'Test prompt',
                maxIterations: 3,
                tools: [createMockTool('find_symbol')],
            };

            await runner.run(config, conversation, createCancellationToken());

            // Tools should only be empty on the LAST iteration (iter 3), not iter 2
            const withTools = toolRequestCounts.filter((r) => r.toolCount > 0);
            const withoutTools = toolRequestCounts.filter(
                (r) => r.toolCount === 0
            );
            expect(withTools.length).toBe(2); // iter 1, 2
            expect(withoutTools.length).toBe(1); // iter 3
        });
    });

    describe('Explicit Completion Budget Warnings', () => {
        it('should inject budget warning at 80% of iterations when requiresExplicitCompletion is true', async () => {
            const addUserMessageSpy = vi.spyOn(conversation, 'addUserMessage');

            // maxIterations=20: explicitWarningIteration = floor(20 * 0.8) = 16
            let callCount = 0;
            const modelManager = {
                sendRequest: vi.fn().mockImplementation((request: any) => {
                    callCount++;
                    if (request.tools.length === 0) {
                        return Promise.resolve({
                            content: 'Final text',
                            toolCalls: undefined,
                        });
                    }
                    return Promise.resolve({
                        content: null,
                        toolCalls: [
                            {
                                id: `call_${callCount}`,
                                function: {
                                    name: 'find_symbol',
                                    arguments: '{}',
                                },
                            },
                        ],
                    });
                }),
                getCurrentModel: vi.fn().mockResolvedValue({
                    id: 'test-model',
                    maxInputTokens: 100000,
                    countTokens: vi.fn().mockResolvedValue(100),
                }),
            } as unknown as CopilotModelManager;

            const toolExecutor = createMockToolExecutor([
                { name: 'find_symbol', success: true, result: 'Found' },
            ]);

            const runner = new ConversationRunner(modelManager, toolExecutor);

            const config: ConversationRunnerConfig = {
                systemPrompt: 'Test prompt',
                maxIterations: 20,
                tools: [createMockTool('find_symbol')],
                requiresExplicitCompletion: true,
            };

            await runner.run(config, conversation, createCancellationToken());

            // Should have the 80% budget warning
            const budgetWarnings = addUserMessageSpy.mock.calls.filter(
                (call) =>
                    typeof call[0] === 'string' &&
                    call[0].includes('Budget warning')
            );
            expect(budgetWarnings.length).toBe(1);
            expect(budgetWarnings[0][0]).toContain(
                '16 of 20 iterations (4 remaining)'
            );
            expect(budgetWarnings[0][0]).toContain('submit_review');
        });

        it('should inject urgent warning at 92% of iterations when requiresExplicitCompletion is true', async () => {
            const addUserMessageSpy = vi.spyOn(conversation, 'addUserMessage');

            // maxIterations=20: explicitUrgentIteration = floor(20 * 0.92) = 18
            let callCount = 0;
            const modelManager = {
                sendRequest: vi.fn().mockImplementation((request: any) => {
                    callCount++;
                    if (request.tools.length === 0) {
                        return Promise.resolve({
                            content: 'Final text',
                            toolCalls: undefined,
                        });
                    }
                    return Promise.resolve({
                        content: null,
                        toolCalls: [
                            {
                                id: `call_${callCount}`,
                                function: {
                                    name: 'find_symbol',
                                    arguments: '{}',
                                },
                            },
                        ],
                    });
                }),
                getCurrentModel: vi.fn().mockResolvedValue({
                    id: 'test-model',
                    maxInputTokens: 100000,
                    countTokens: vi.fn().mockResolvedValue(100),
                }),
            } as unknown as CopilotModelManager;

            const toolExecutor = createMockToolExecutor([
                { name: 'find_symbol', success: true, result: 'Found' },
            ]);

            const runner = new ConversationRunner(modelManager, toolExecutor);

            const config: ConversationRunnerConfig = {
                systemPrompt: 'Test prompt',
                maxIterations: 20,
                tools: [createMockTool('find_symbol')],
                requiresExplicitCompletion: true,
            };

            await runner.run(config, conversation, createCancellationToken());

            // Should have the urgent 92% warning
            const urgentWarnings = addUserMessageSpy.mock.calls.filter(
                (call) =>
                    typeof call[0] === 'string' && call[0].includes('URGENT')
            );
            expect(urgentWarnings.length).toBe(1);
            expect(urgentWarnings[0][0]).toContain(
                'Only 2 iteration(s) remaining out of 20'
            );
            expect(urgentWarnings[0][0]).toContain(
                'MUST call submit_review NOW'
            );
        });

        it('should NOT inject explicit-completion budget warnings when requiresExplicitCompletion is false', async () => {
            const addUserMessageSpy = vi.spyOn(conversation, 'addUserMessage');

            let callCount = 0;
            const modelManager = {
                sendRequest: vi.fn().mockImplementation((request: any) => {
                    callCount++;
                    if (request.tools.length === 0) {
                        return Promise.resolve({
                            content: 'Final text',
                            toolCalls: undefined,
                        });
                    }
                    return Promise.resolve({
                        content: null,
                        toolCalls: [
                            {
                                id: `call_${callCount}`,
                                function: {
                                    name: 'find_symbol',
                                    arguments: '{}',
                                },
                            },
                        ],
                    });
                }),
                getCurrentModel: vi.fn().mockResolvedValue({
                    id: 'test-model',
                    maxInputTokens: 100000,
                    countTokens: vi.fn().mockResolvedValue(100),
                }),
            } as unknown as CopilotModelManager;

            const toolExecutor = createMockToolExecutor([
                { name: 'find_symbol', success: true, result: 'Found' },
            ]);

            const runner = new ConversationRunner(modelManager, toolExecutor);

            const config: ConversationRunnerConfig = {
                systemPrompt: 'Test prompt',
                maxIterations: 20,
                tools: [createMockTool('find_symbol')],
                // requiresExplicitCompletion defaults to false
            };

            await runner.run(config, conversation, createCancellationToken());

            // Should NOT have explicit-completion budget warnings
            const budgetWarnings = addUserMessageSpy.mock.calls.filter(
                (call) =>
                    typeof call[0] === 'string' &&
                    call[0].includes('Budget warning')
            );
            expect(budgetWarnings.length).toBe(0);

            // Should NOT have explicit-completion urgent warnings
            // (the URGENT that fires is the subagent wind-down one, not explicit-completion)
            const explicitUrgent = addUserMessageSpy.mock.calls.filter(
                (call) =>
                    typeof call[0] === 'string' &&
                    call[0].includes('MUST call submit_review NOW')
            );
            expect(explicitUrgent.length).toBe(0);
        });

        it('should skip warning and only fire urgent when thresholds collide for small maxIterations', async () => {
            const addUserMessageSpy = vi.spyOn(conversation, 'addUserMessage');

            // maxIterations=5: both thresholds round to 4
            let callCount = 0;
            const modelManager = {
                sendRequest: vi.fn().mockImplementation((request: any) => {
                    callCount++;
                    if (request.tools.length === 0) {
                        return Promise.resolve({
                            content: 'Final text',
                            toolCalls: undefined,
                        });
                    }
                    return Promise.resolve({
                        content: null,
                        toolCalls: [
                            {
                                id: `call_${callCount}`,
                                function: {
                                    name: 'find_symbol',
                                    arguments: '{}',
                                },
                            },
                        ],
                    });
                }),
                getCurrentModel: vi.fn().mockResolvedValue({
                    id: 'test-model',
                    maxInputTokens: 100000,
                    countTokens: vi.fn().mockResolvedValue(100),
                }),
            } as unknown as CopilotModelManager;

            const toolExecutor = createMockToolExecutor([
                { name: 'find_symbol', success: true, result: 'Found' },
            ]);

            const runner = new ConversationRunner(modelManager, toolExecutor);

            const config: ConversationRunnerConfig = {
                systemPrompt: 'Test prompt',
                maxIterations: 5,
                tools: [createMockTool('find_symbol')],
                requiresExplicitCompletion: true,
            };

            await runner.run(config, conversation, createCancellationToken());

            // Budget warning should NOT fire (skipped because thresholds collide)
            const budgetWarnings = addUserMessageSpy.mock.calls.filter(
                (call) =>
                    typeof call[0] === 'string' &&
                    call[0].includes('Budget warning')
            );
            expect(budgetWarnings.length).toBe(0);

            // Only the urgent warning should fire
            const urgentWarnings = addUserMessageSpy.mock.calls.filter(
                (call) =>
                    typeof call[0] === 'string' && call[0].includes('URGENT')
            );
            expect(urgentWarnings.length).toBe(1);
        });
    });

    describe('disabledToolNames', () => {
        it('should filter out disabled tools from LLM requests', async () => {
            const modelManager = createMockModelManager([
                {
                    content: null,
                    toolCalls: [
                        {
                            id: 'call_1',
                            function: {
                                name: 'find_symbol',
                                arguments: '{}',
                            },
                        },
                    ],
                },
                { content: 'Done', toolCalls: undefined },
            ]);

            const toolExecutor = createMockToolExecutor([
                { name: 'find_symbol', success: true, result: 'Found' },
            ]);

            const runner = new ConversationRunner(modelManager, toolExecutor);

            const disabledTools = new Set<string>();

            const config: ConversationRunnerConfig = {
                systemPrompt: 'Test prompt',
                maxIterations: 5,
                tools: [
                    createMockTool('find_symbol'),
                    createMockTool('read_file'),
                    createMockTool('run_subagent_batch'),
                ],
                disabledToolNames: disabledTools,
            };

            // Disable read_file before running
            disabledTools.add('read_file');

            await runner.run(config, conversation, createCancellationToken());

            // Verify that the tools sent to the LLM exclude read_file
            const calls = (modelManager.sendRequest as ReturnType<typeof vi.fn>)
                .mock.calls;
            const firstCallTools = calls[0][0].tools;
            const toolNames = firstCallTools.map(
                (t: { name: string }) => t.name
            );
            expect(toolNames).toContain('find_symbol');
            expect(toolNames).toContain('run_subagent_batch');
            expect(toolNames).not.toContain('read_file');
        });

        it('should block disabled tool calls at execution time (defense-in-depth)', async () => {
            const modelManager = createMockModelManager([
                {
                    content: null,
                    toolCalls: [
                        {
                            id: 'call_1',
                            function: {
                                name: 'find_symbol',
                                arguments: '{}',
                            },
                        },
                        {
                            id: 'call_2',
                            function: {
                                name: 'read_file',
                                arguments: '{}',
                            },
                        },
                    ],
                },
                { content: 'Done', toolCalls: undefined },
            ]);

            const toolExecutor = createMockToolExecutor([
                { name: 'find_symbol', success: true, result: 'Found' },
            ]);

            const runner = new ConversationRunner(modelManager, toolExecutor);

            const disabledTools = new Set(['read_file']);

            const config: ConversationRunnerConfig = {
                systemPrompt: 'Test prompt',
                maxIterations: 5,
                tools: [
                    createMockTool('find_symbol'),
                    createMockTool('read_file'),
                ],
                disabledToolNames: disabledTools,
            };

            await runner.run(config, conversation, createCancellationToken());

            // Verify that only allowed tool was executed
            const executeCalls = (
                toolExecutor.executeTools as ReturnType<typeof vi.fn>
            ).mock.calls;
            expect(executeCalls.length).toBe(1);
            const executedNames = executeCalls[0][0].map(
                (r: { name: string }) => r.name
            );
            expect(executedNames).toEqual(['find_symbol']);
            expect(executedNames).not.toContain('read_file');
        });
    });

    describe('Rate-Limit Retry', () => {
        class ChatRateLimited extends Error {
            constructor(message = 'Rate limited') {
                super(message);
                this.name = 'ChatRateLimited';
            }
        }

        beforeEach(() => {
            vi.useFakeTimers();
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        it('should retry on rate-limit error without consuming an iteration', async () => {
            let callCount = 0;
            const modelManager = {
                sendRequest: vi.fn().mockImplementation(() => {
                    callCount++;
                    if (callCount === 1) {
                        return Promise.reject(new ChatRateLimited());
                    }
                    return Promise.resolve({
                        content: 'Success after retry',
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
                maxIterations: 2,
                tools: [],
            };

            conversation.addUserMessage('Test');
            const resultPromise = runner.run(
                config,
                conversation,
                createCancellationToken()
            );

            // Advance through the backoff sleep
            await vi.advanceTimersByTimeAsync(60000);

            const result = await resultPromise;

            expect(result).toBe('Success after retry');
            expect(modelManager.sendRequest).toHaveBeenCalledTimes(2);
            expect(runner.hitMaxIterations).toBe(false);
        });

        it('should not over-report iterationsUsed on rate-limit retry', async () => {
            let callCount = 0;
            const modelManager = {
                sendRequest: vi.fn().mockImplementation(() => {
                    callCount++;
                    if (callCount === 1) {
                        return Promise.reject(new ChatRateLimited());
                    }
                    return Promise.resolve({
                        content: 'Success after retry',
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

            conversation.addUserMessage('Test');
            const resultPromise = runner.run(
                config,
                conversation,
                createCancellationToken()
            );

            await vi.advanceTimersByTimeAsync(60000);
            await resultPromise;

            // Rate-limited attempt should not count: 1 successful iteration, not 2
            expect(runner.iterationsUsed).toBe(1);
        });

        it('should return gracefully when retries are exhausted', async () => {
            const modelManager = {
                sendRequest: vi.fn().mockImplementation(() => {
                    return Promise.reject(new ChatRateLimited());
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

            conversation.addUserMessage('Test');
            const resultPromise = runner.run(
                config,
                conversation,
                createCancellationToken()
            );

            // Advance through all retry backoffs (5 retries with exponential backoff)
            for (let i = 0; i < 10; i++) {
                await vi.advanceTimersByTimeAsync(60000);
            }

            const result = await resultPromise;

            expect(result).toContain('Rate limited');
            expect(runner.hitRateLimit).toBe(true);
            expect(runner.hitMaxIterations).toBe(false);
        });

        it('should return last substantive response when retries exhausted', async () => {
            let callCount = 0;
            const modelManager = {
                sendRequest: vi.fn().mockImplementation(() => {
                    callCount++;
                    if (callCount === 1) {
                        return Promise.resolve({
                            content:
                                'I found a critical issue: the authentication module has a bypass vulnerability that allows unauthenticated access.',
                            toolCalls: [
                                {
                                    id: 'call_1',
                                    function: {
                                        name: 'find_symbol',
                                        arguments: '{}',
                                    },
                                },
                            ],
                        });
                    }
                    return Promise.reject(new ChatRateLimited());
                }),
                getCurrentModel: vi.fn().mockResolvedValue({
                    id: 'test-model',
                    maxInputTokens: 100000,
                    countTokens: vi.fn().mockResolvedValue(100),
                }),
            } as unknown as CopilotModelManager;
            const toolExecutor = createMockToolExecutor([
                { name: 'find_symbol', success: true, result: 'Found' },
            ]);
            const runner = new ConversationRunner(modelManager, toolExecutor);

            const config: ConversationRunnerConfig = {
                systemPrompt: 'Test prompt',
                maxIterations: 10,
                tools: [createMockTool('find_symbol')],
            };

            conversation.addUserMessage('Test');
            const resultPromise = runner.run(
                config,
                conversation,
                createCancellationToken()
            );

            for (let i = 0; i < 10; i++) {
                await vi.advanceTimersByTimeAsync(60000);
            }

            const result = await resultPromise;

            expect(result).toContain('authentication module');
        });

        it('should keep tools disabled when rate-limit retry happens after wind-down', async () => {
            let callCount = 0;
            const modelManager = {
                sendRequest: vi.fn().mockImplementation((_request: any) => {
                    callCount++;
                    if (callCount === 1) {
                        return Promise.resolve({
                            content: null,
                            toolCalls: [
                                {
                                    id: 'call_1',
                                    function: {
                                        name: 'find_symbol',
                                        arguments: '{}',
                                    },
                                },
                            ],
                        });
                    }
                    if (callCount === 2) {
                        return Promise.reject(new ChatRateLimited());
                    }
                    // Retry after rate-limit: tools should STILL be empty (verified below)
                    return Promise.resolve({
                        content: 'Final findings after rate-limit retry',
                        toolCalls: undefined,
                    });
                }),
                getCurrentModel: vi.fn().mockResolvedValue({
                    id: 'test-model',
                    maxInputTokens: 100000,
                    countTokens: vi.fn().mockResolvedValue(100),
                }),
            } as unknown as CopilotModelManager;

            const toolExecutor = createMockToolExecutor([
                { name: 'find_symbol', success: true, result: 'Found' },
            ]);
            const runner = new ConversationRunner(modelManager, toolExecutor);

            const config: ConversationRunnerConfig = {
                systemPrompt: 'Test prompt',
                maxIterations: 2,
                tools: [createMockTool('find_symbol')],
            };

            conversation.addUserMessage('Test');
            const resultPromise = runner.run(
                config,
                conversation,
                createCancellationToken()
            );

            await vi.advanceTimersByTimeAsync(60000);

            const result = await resultPromise;

            expect(result).toBe('Final findings after rate-limit retry');
            expect(modelManager.sendRequest).toHaveBeenCalledTimes(3);
            // The 3rd call (after rate-limit retry) should have empty tools
            const thirdCallArgs = (
                modelManager.sendRequest as ReturnType<typeof vi.fn>
            ).mock.calls[2][0];
            expect(thirdCallArgs.tools).toHaveLength(0);
        });

        it('should detect rate-limit error by class name', async () => {
            let callCount = 0;
            const modelManager = {
                sendRequest: vi.fn().mockImplementation(() => {
                    callCount++;
                    if (callCount === 1) {
                        const err = new Error('some error');
                        Object.defineProperty(err, 'constructor', {
                            value: { name: 'ChatRateLimited' },
                        });
                        return Promise.reject(err);
                    }
                    return Promise.resolve({
                        content: 'Success',
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
                systemPrompt: 'Test',
                maxIterations: 5,
                tools: [],
            };

            conversation.addUserMessage('Test');
            const resultPromise = runner.run(
                config,
                conversation,
                createCancellationToken()
            );

            await vi.advanceTimersByTimeAsync(60000);

            const result = await resultPromise;
            expect(result).toBe('Success');
        });

        it('should detect rate-limit error by message content', async () => {
            let callCount = 0;
            const modelManager = {
                sendRequest: vi.fn().mockImplementation(() => {
                    callCount++;
                    if (callCount === 1) {
                        return Promise.reject(
                            new Error('Request was rate limited by the server')
                        );
                    }
                    return Promise.resolve({
                        content: 'Success',
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
                systemPrompt: 'Test',
                maxIterations: 5,
                tools: [],
            };

            conversation.addUserMessage('Test');
            const resultPromise = runner.run(
                config,
                conversation,
                createCancellationToken()
            );

            await vi.advanceTimersByTimeAsync(60000);

            const result = await resultPromise;
            expect(result).toBe('Success');
        });

        it('should not retry non-rate-limit errors with backoff', async () => {
            let callCount = 0;
            const modelManager = {
                sendRequest: vi.fn().mockImplementation(() => {
                    callCount++;
                    if (callCount === 1) {
                        return Promise.reject(
                            new Error('Internal server error')
                        );
                    }
                    return Promise.resolve({
                        content: 'Recovery',
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
                systemPrompt: 'Test',
                maxIterations: 3,
                tools: [],
            };

            conversation.addUserMessage('Test');
            const resultPromise = runner.run(
                config,
                conversation,
                createCancellationToken()
            );

            // No timer advancement needed — non-rate-limit errors don't backoff sleep
            const result = await resultPromise;

            // Error consumed an iteration (unlike rate-limit which doesn't),
            // then the next iteration succeeded
            expect(result).toBe('Recovery');
            expect(modelManager.sendRequest).toHaveBeenCalledTimes(2);
        });

        it('should reset rate-limit counter after a successful response', async () => {
            // Sequence: rate-limit → success (with tool call) → rate-limit → success
            // If counter doesn't reset, the second rate-limit would start at retry=1
            // instead of retry=0, reaching the max faster.
            let callCount = 0;
            const modelManager = {
                sendRequest: vi.fn().mockImplementation(() => {
                    callCount++;
                    if (callCount === 1) {
                        return Promise.reject(new ChatRateLimited());
                    }
                    if (callCount === 2) {
                        // Successful response with tool call to trigger another iteration
                        return Promise.resolve({
                            content: null,
                            toolCalls: [
                                {
                                    id: 'call_1',
                                    function: {
                                        name: 'test_tool',
                                        arguments: '{}',
                                    },
                                },
                            ],
                        });
                    }
                    if (callCount === 3) {
                        return Promise.reject(new ChatRateLimited());
                    }
                    // Final success
                    return Promise.resolve({
                        content: 'Final result',
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
                systemPrompt: 'Test',
                maxIterations: 10,
                tools: [],
            };

            conversation.addUserMessage('Test');
            const resultPromise = runner.run(
                config,
                conversation,
                createCancellationToken()
            );

            // Advance through both rate-limit backoffs
            await vi.advanceTimersByTimeAsync(120000);

            const result = await resultPromise;
            expect(result).toBe('Final result');
            // All 4 calls should have been made (2 rate-limits + 2 successes)
            expect(modelManager.sendRequest).toHaveBeenCalledTimes(4);
        });

        describe('Quota Exhaustion', () => {
            it('should retry ChatRateLimited with quota-flavored message (HTTP 429)', async () => {
                // The "exceeded your Copilot token usage" message uses
                // ChatRateLimited (HTTP 429) — a temporary burst throttle,
                // not the monthly quota. Should retry with normal backoff.
                let callCount = 0;
                const modelManager = {
                    sendRequest: vi.fn().mockImplementation(() => {
                        callCount++;
                        if (callCount === 1) {
                            const err = new Error(
                                'Sorry, you have exceeded your Copilot token usage. Please review our Terms of Service'
                            );
                            err.name = 'ChatRateLimited';
                            return Promise.reject(err);
                        }
                        return Promise.resolve({
                            content: 'Success after backoff',
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
                const runner = new ConversationRunner(
                    modelManager,
                    toolExecutor
                );

                const config: ConversationRunnerConfig = {
                    systemPrompt: 'Test prompt',
                    maxIterations: 10,
                    tools: [],
                };

                conversation.addUserMessage('Test');
                const resultPromise = runner.run(
                    config,
                    conversation,
                    createCancellationToken()
                );

                // Quota-flavored backoff uses standard 2s initial
                await vi.advanceTimersByTimeAsync(60000);

                const result = await resultPromise;

                // Should retry and succeed — NOT kill immediately
                expect(result).toBe('Success after backoff');
                expect(modelManager.sendRequest).toHaveBeenCalledTimes(2);
                expect(runner.hitQuotaExhausted).toBe(false);
                expect(runner.hitRateLimit).toBe(false);
            });

            it('should return last substantive response when retries exhausted on quota-flavored errors', async () => {
                let callCount = 0;
                const modelManager = {
                    sendRequest: vi.fn().mockImplementation(() => {
                        callCount++;
                        if (callCount === 1) {
                            return Promise.resolve({
                                content: null,
                                toolCalls: [
                                    {
                                        id: 'call_1',
                                        function: {
                                            name: 'test_tool',
                                            arguments: '{}',
                                        },
                                    },
                                ],
                            });
                        }
                        if (callCount === 2) {
                            return Promise.resolve({
                                content:
                                    'Found a critical security vulnerability in the auth.ts module that allows bypass',
                                toolCalls: [
                                    {
                                        id: 'call_2',
                                        function: {
                                            name: 'test_tool',
                                            arguments: '{}',
                                        },
                                    },
                                ],
                            });
                        }
                        // All subsequent calls: quota-flavored rate limit
                        const err = new Error(
                            'Sorry, you have exceeded your Copilot token usage.'
                        );
                        err.name = 'ChatRateLimited';
                        return Promise.reject(err);
                    }),
                    getCurrentModel: vi.fn().mockResolvedValue({
                        id: 'test-model',
                        maxInputTokens: 100000,
                        countTokens: vi.fn().mockResolvedValue(100),
                    }),
                } as unknown as CopilotModelManager;
                const toolExecutor = createMockToolExecutor([
                    {
                        name: 'test_tool',
                        success: true,
                        result: 'Tool result',
                    },
                ]);
                const runner = new ConversationRunner(
                    modelManager,
                    toolExecutor
                );

                const config: ConversationRunnerConfig = {
                    systemPrompt: 'Test prompt',
                    maxIterations: 10,
                    tools: [createMockTool('test_tool')],
                };

                conversation.addUserMessage('Test');
                const resultPromise = runner.run(
                    config,
                    conversation,
                    createCancellationToken()
                );

                // Advance through all retry backoffs
                for (let i = 0; i < 10; i++) {
                    await vi.advanceTimersByTimeAsync(120000);
                }

                const result = await resultPromise;

                // Should exhaust retries and return last good response
                expect(result).toContain('critical security vulnerability');
                expect(runner.hitRateLimit).toBe(true);
            });

            it('should fail immediately on true ChatQuotaExceeded (HTTP 402)', async () => {
                // ChatQuotaExceeded = monthly premium request quota depleted.
                // No retry will help — quota resets monthly.
                class ChatQuotaExceeded extends Error {
                    constructor() {
                        super('Quota exceeded');
                        this.name = 'ChatQuotaExceeded';
                    }
                }

                const modelManager = {
                    sendRequest: vi
                        .fn()
                        .mockRejectedValue(new ChatQuotaExceeded()),
                    getCurrentModel: vi.fn().mockResolvedValue({
                        id: 'test-model',
                        maxInputTokens: 100000,
                        countTokens: vi.fn().mockResolvedValue(100),
                    }),
                } as unknown as CopilotModelManager;
                const toolExecutor = createMockToolExecutor();
                const runner = new ConversationRunner(
                    modelManager,
                    toolExecutor
                );

                const config: ConversationRunnerConfig = {
                    systemPrompt: 'Test',
                    maxIterations: 5,
                    tools: [],
                };

                conversation.addUserMessage('Test');
                const result = await runner.run(
                    config,
                    conversation,
                    createCancellationToken()
                );

                // True quota: 1 attempt, no retries
                expect(modelManager.sendRequest).toHaveBeenCalledTimes(1);
                expect(runner.hitQuotaExhausted).toBe(true);
                expect(runner.hitRateLimit).toBe(true);
                expect(result).toContain('quota exhausted');
            });

            it('should reset hitQuotaExhausted flag on reset()', async () => {
                class ChatQuotaExceeded extends Error {
                    constructor() {
                        super('Quota exceeded');
                        this.name = 'ChatQuotaExceeded';
                    }
                }

                const modelManager = {
                    sendRequest: vi
                        .fn()
                        .mockRejectedValue(new ChatQuotaExceeded()),
                    getCurrentModel: vi.fn().mockResolvedValue({
                        id: 'test-model',
                        maxInputTokens: 100000,
                        countTokens: vi.fn().mockResolvedValue(100),
                    }),
                } as unknown as CopilotModelManager;
                const toolExecutor = createMockToolExecutor();
                const runner = new ConversationRunner(
                    modelManager,
                    toolExecutor
                );

                const config: ConversationRunnerConfig = {
                    systemPrompt: 'Test',
                    maxIterations: 5,
                    tools: [],
                };

                conversation.addUserMessage('Test');
                await runner.run(
                    config,
                    conversation,
                    createCancellationToken()
                );
                expect(runner.hitQuotaExhausted).toBe(true);

                runner.reset();
                expect(runner.hitQuotaExhausted).toBe(false);
            });
        });
    });

    describe('Response Too Long', () => {
        it('should retry with guidance on first "Response too long" error', async () => {
            let callCount = 0;
            const modelManager = {
                sendRequest: vi.fn().mockImplementation(() => {
                    callCount++;
                    if (callCount === 1) {
                        return Promise.reject(new Error('Response too long.'));
                    }
                    return Promise.resolve({
                        content: 'Concise response',
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
                maxIterations: 5,
                tools: [],
            };

            conversation.addUserMessage('Test');
            const result = await runner.run(
                config,
                conversation,
                createCancellationToken()
            );

            expect(result).toBe('Concise response');
            expect(modelManager.sendRequest).toHaveBeenCalledTimes(2);
            // Should not count the failed attempt as an iteration
            expect(runner.iterationsUsed).toBe(1);
        });

        it('should give up after exceeding max response-too-long retries', async () => {
            const modelManager = {
                sendRequest: vi
                    .fn()
                    .mockRejectedValue(new Error('Response too long.')),
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
                maxIterations: 50,
                tools: [],
            };

            conversation.addUserMessage('Test');
            const result = await runner.run(
                config,
                conversation,
                createCancellationToken()
            );

            expect(result).toContain(
                'consistently generated responses that exceeded'
            );
            // 1 initial + MAX_RESPONSE_TOO_LONG_RETRIES (2) = 3 total calls
            expect(modelManager.sendRequest).toHaveBeenCalledTimes(3);
        });

        it('should not burn iterations on response-too-long errors', async () => {
            let callCount = 0;
            const modelManager = {
                sendRequest: vi.fn().mockImplementation(() => {
                    callCount++;
                    if (callCount <= 2) {
                        return Promise.reject(new Error('Response too long.'));
                    }
                    return Promise.resolve({
                        content: 'Finally concise',
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
                maxIterations: 5,
                tools: [],
            };

            conversation.addUserMessage('Test');
            const result = await runner.run(
                config,
                conversation,
                createCancellationToken()
            );

            expect(result).toBe('Finally concise');
            // Two retries + one success = 3 calls, but only 1 iteration used
            expect(modelManager.sendRequest).toHaveBeenCalledTimes(3);
            expect(runner.iterationsUsed).toBe(1);
        });
    });

    describe('Scoped executor cleanup', () => {
        it('should restore executionContext.toolExecutor after run() completes', async () => {
            const modelManager = createMockModelManager([
                { content: 'Done', toolCalls: undefined },
            ]);

            const executionContext = { toolExecutor: undefined as any };
            const originalExecutor = {} as ToolExecutor;
            executionContext.toolExecutor = originalExecutor;

            const scopedExecutor = {
                executeTools: vi.fn().mockResolvedValue([]),
                getAvailableTools: vi.fn().mockReturnValue([]),
                createScoped: vi.fn(),
                getExecutionContext: vi.fn().mockReturnValue(executionContext),
            } as unknown as ToolExecutor;

            const mockExecutor = {
                executeTools: vi.fn().mockResolvedValue([]),
                getAvailableTools: vi.fn().mockReturnValue([]),
                createScoped: vi.fn().mockImplementation(() => {
                    executionContext.toolExecutor = scopedExecutor;
                    return scopedExecutor;
                }),
                getExecutionContext: vi.fn().mockReturnValue(executionContext),
            } as unknown as ToolExecutor;

            const runner = new ConversationRunner(modelManager, mockExecutor);

            const config: ConversationRunnerConfig = {
                systemPrompt: 'Test prompt',
                maxIterations: 5,
                tools: [],
            };

            conversation.addUserMessage('Test');
            await runner.run(config, conversation, createCancellationToken());

            expect(executionContext.toolExecutor).toBe(originalExecutor);
        });

        it('should restore executionContext.toolExecutor even when run() throws', async () => {
            const modelManager = {
                sendRequest: vi.fn().mockRejectedValue(
                    Object.assign(new Error('service unavailable'), {
                        code: 'ServiceUnavailable',
                    })
                ),
                getCurrentModel: vi.fn().mockResolvedValue({
                    id: 'test-model',
                    maxInputTokens: 100000,
                    countTokens: vi.fn().mockResolvedValue(100),
                }),
            } as unknown as CopilotModelManager;

            const executionContext = { toolExecutor: undefined as any };
            const originalExecutor = {} as ToolExecutor;
            executionContext.toolExecutor = originalExecutor;

            const scopedExecutor = {
                executeTools: vi.fn().mockResolvedValue([]),
                getAvailableTools: vi.fn().mockReturnValue([]),
                createScoped: vi.fn(),
                getExecutionContext: vi.fn().mockReturnValue(executionContext),
            } as unknown as ToolExecutor;

            const mockExecutor = {
                executeTools: vi.fn().mockResolvedValue([]),
                getAvailableTools: vi.fn().mockReturnValue([]),
                createScoped: vi.fn().mockImplementation(() => {
                    executionContext.toolExecutor = scopedExecutor;
                    return scopedExecutor;
                }),
                getExecutionContext: vi.fn().mockReturnValue(executionContext),
            } as unknown as ToolExecutor;

            const runner = new ConversationRunner(modelManager, mockExecutor);

            const config: ConversationRunnerConfig = {
                systemPrompt: 'Test prompt',
                maxIterations: 5,
                tools: [],
            };

            conversation.addUserMessage('Test');
            await expect(
                runner.run(config, conversation, createCancellationToken())
            ).rejects.toThrow('service unavailable');

            expect(executionContext.toolExecutor).toBe(originalExecutor);
        });
    });
});

describe('ConversationRunner.sleepWithCancellation', () => {
    let runner: ConversationRunner;

    beforeEach(() => {
        runner = new ConversationRunner(
            createMockModelManager([]) as unknown as CopilotModelManager,
            createMockToolExecutor() as unknown as ToolExecutor
        );
    });

    it('resolves immediately when token is already cancelled', async () => {
        const tokenSource = new vscode.CancellationTokenSource();
        tokenSource.cancel();

        const sleep = (runner as any).sleepWithCancellation(
            1000,
            tokenSource.token
        );
        await expect(sleep).resolves.toBeUndefined();
    });

    it('resolves exactly once when cancellation races with timer expiry', async () => {
        vi.useFakeTimers();
        try {
            const tokenSource = new vscode.CancellationTokenSource();
            const sleep = (runner as any).sleepWithCancellation(
                10,
                tokenSource.token
            );

            // Cancel at exactly the 10ms boundary to race with the timer
            setTimeout(() => tokenSource.cancel(), 10);

            await vi.advanceTimersByTimeAsync(10);
            await sleep;
            // Should resolve cleanly without throwing or hanging
        } finally {
            vi.useRealTimers();
        }
    });

    it('resolves via timer when cancellation never fires', async () => {
        vi.useFakeTimers();
        try {
            const tokenSource = new vscode.CancellationTokenSource();
            const sleep = (runner as any).sleepWithCancellation(
                50,
                tokenSource.token
            );

            const resolved = vi.fn();
            sleep.then(resolved, resolved);

            vi.advanceTimersByTime(50);
            await sleep;
            expect(resolved).toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });
});
