import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import { ModelRequestHandler } from '../models/modelRequestHandler';
import type { ToolCallRequest, ToolCallMessage } from '../types/modelTypes';
import { TimeoutError } from '../types/errorTypes';
import { isTimeoutError } from '../utils/asyncUtils';

describe('ModelRequestHandler', () => {
    let mockModel: any;
    let cancellationTokenSource: vscode.CancellationTokenSource;

    beforeEach(() => {
        mockModel = {
            id: 'test-model',
            name: 'Test Model',
            family: 'test-family',
            version: '1.0',
            maxInputTokens: 4096,
            sendRequest: vi.fn(),
            countTokens: vi.fn().mockResolvedValue(10),
        };

        cancellationTokenSource = new vscode.CancellationTokenSource();
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    describe('convertMessages', () => {
        it('should convert system messages to Assistant messages (VS Code API quirk)', () => {
            const messages: ToolCallMessage[] = [
                { role: 'system', content: 'You are a helpful assistant.' },
            ];

            const result = ModelRequestHandler.convertMessages(messages);

            expect(result).toHaveLength(1);
            expect(
                vscode.LanguageModelChatMessage.Assistant
            ).toHaveBeenCalledWith('You are a helpful assistant.');
        });

        it('should convert user messages to User messages', () => {
            const messages: ToolCallMessage[] = [
                { role: 'user', content: 'Hello, world!' },
            ];

            const result = ModelRequestHandler.convertMessages(messages);

            expect(result).toHaveLength(1);
            expect(vscode.LanguageModelChatMessage.User).toHaveBeenCalledWith(
                'Hello, world!'
            );
        });

        it('should convert assistant messages with text content', () => {
            const messages: ToolCallMessage[] = [
                { role: 'assistant', content: 'I can help with that.' },
            ];

            const result = ModelRequestHandler.convertMessages(messages);

            expect(result).toHaveLength(1);
            expect(
                vscode.LanguageModelChatMessage.Assistant
            ).toHaveBeenCalled();
        });

        it('should convert assistant messages with tool calls', () => {
            const messages: ToolCallMessage[] = [
                {
                    role: 'assistant',
                    content: null,
                    toolCalls: [
                        {
                            id: 'call-123',
                            function: {
                                name: 'readFile',
                                arguments: JSON.stringify({ path: '/test.ts' }),
                            },
                        },
                    ],
                },
            ];

            const result = ModelRequestHandler.convertMessages(messages);

            expect(result).toHaveLength(1);
            expect(
                vscode.LanguageModelChatMessage.Assistant
            ).toHaveBeenCalled();
        });

        it('should convert tool response messages to User with ToolResultPart', () => {
            const messages: ToolCallMessage[] = [
                {
                    role: 'tool',
                    content: 'File contents here',
                    toolCallId: 'call-123',
                },
            ];

            const result = ModelRequestHandler.convertMessages(messages);

            expect(result).toHaveLength(1);
            expect(vscode.LanguageModelChatMessage.User).toHaveBeenCalled();
        });

        it('should handle mixed message types', () => {
            const messages: ToolCallMessage[] = [
                { role: 'system', content: 'System prompt' },
                { role: 'user', content: 'User question' },
                { role: 'assistant', content: 'Assistant response' },
                { role: 'user', content: 'Follow up' },
            ];

            const result = ModelRequestHandler.convertMessages(messages);

            expect(result).toHaveLength(4);
        });

        it('should skip messages with null content for user role', () => {
            const messages: ToolCallMessage[] = [
                { role: 'user', content: null },
            ];

            const result = ModelRequestHandler.convertMessages(messages);

            // User messages with null content are skipped
            expect(result).toHaveLength(0);
        });

        it('should throw error for invalid JSON in tool call arguments', () => {
            const messages: ToolCallMessage[] = [
                {
                    role: 'assistant',
                    content: null,
                    toolCalls: [
                        {
                            id: 'call-123',
                            function: {
                                name: 'readFile',
                                arguments: '{ invalid json }',
                            },
                        },
                    ],
                },
            ];

            const result = ModelRequestHandler.convertMessages(messages);
            expect(result).toHaveLength(1);
            expect(result[0].role).toBe(
                vscode.LanguageModelChatMessageRole.Assistant
            );
            expect(result[0].content).toEqual([
                new vscode.LanguageModelTextPart(''),
            ]);
        });

        it('should ensure assistant message has at least empty text part if content is empty', () => {
            const messages: ToolCallMessage[] = [
                { role: 'assistant', content: null },
            ];

            const result = ModelRequestHandler.convertMessages(messages);

            expect(result).toHaveLength(1);
            expect(
                vscode.LanguageModelChatMessage.Assistant
            ).toHaveBeenCalledWith(
                expect.arrayContaining([
                    expect.any(vscode.LanguageModelTextPart),
                ])
            );
        });
    });

    describe('withTimeout', () => {
        it('should resolve if thenable completes before timeout', async () => {
            const thenable = Promise.resolve('success');

            const result = await ModelRequestHandler.withTimeout(
                thenable,
                1000, // 1 second timeout
                cancellationTokenSource.token
            );

            expect(result).toBe('success');
        });

        it('should reject with timeout error if thenable takes too long', async () => {
            // Create a promise that never resolves
            const thenable = new Promise(() => {});

            await expect(
                ModelRequestHandler.withTimeout(
                    thenable,
                    50, // 50ms timeout
                    cancellationTokenSource.token
                )
            ).rejects.toSatisfy((error: unknown) => isTimeoutError(error));
        }, 1000);

        it('should include operation details in timeout error', async () => {
            const thenable = new Promise(() => {});

            try {
                await ModelRequestHandler.withTimeout(
                    thenable,
                    50,
                    cancellationTokenSource.token
                );
                expect.fail('Should have thrown');
            } catch (error) {
                expect(isTimeoutError(error)).toBe(true);
                expect((error as TimeoutError).operation).toBe('LLM request');
                expect((error as TimeoutError).timeoutMs).toBe(50);
            }
        }, 1000);

        it('should reject immediately if token is cancelled', async () => {
            const thenable = new Promise(() => {}); // Never resolves

            // Cancel immediately
            cancellationTokenSource.cancel();

            await expect(
                ModelRequestHandler.withTimeout(
                    thenable,
                    1000,
                    cancellationTokenSource.token
                )
            ).rejects.toThrow();
        });

        it('should suppress late rejections when token is pre-cancelled', async () => {
            // This test verifies the fix for the unhandled rejection bug:
            // When token is already cancelled, we throw CancellationError early,
            // but the underlying thenable may still reject later. The .catch() handler
            // must be attached BEFORE the early throw to suppress this rejection.
            let unhandledRejection = false;
            const handler = () => {
                unhandledRejection = true;
            };
            process.on('unhandledRejection', handler);

            try {
                // Create a thenable that rejects after a delay
                let rejectThenable: (reason: unknown) => void;
                const thenable = new Promise<string>((_, reject) => {
                    rejectThenable = reject;
                });

                // Pre-cancel the token
                cancellationTokenSource.cancel();

                // This should throw CancellationError immediately
                await expect(
                    ModelRequestHandler.withTimeout(
                        thenable,
                        5000,
                        cancellationTokenSource.token
                    )
                ).rejects.toThrow();

                // Now reject the thenable after the early exit
                rejectThenable!(new Error('late rejection'));

                // Give event loop time to process the rejection
                await new Promise((resolve) => setTimeout(resolve, 50));

                // Should not have caused an unhandled rejection
                expect(unhandledRejection).toBe(false);
            } finally {
                process.off('unhandledRejection', handler);
            }
        });

        it('should reject if token is cancelled during execution', async () => {
            const thenable = new Promise(() => {}); // Never resolves

            const promise = ModelRequestHandler.withTimeout(
                thenable,
                1000,
                cancellationTokenSource.token
            );

            // Cancel after a small delay
            setTimeout(() => cancellationTokenSource.cancel(), 10);

            await expect(promise).rejects.toThrow();
        });

        it('should propagate errors from the thenable', async () => {
            const thenable = Promise.reject(new Error('Model error'));

            await expect(
                ModelRequestHandler.withTimeout(
                    thenable,
                    1000,
                    cancellationTokenSource.token
                )
            ).rejects.toThrow('Model error');
        });

        it('should cleanup timeout on success', async () => {
            const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');
            const thenable = Promise.resolve('success');

            await ModelRequestHandler.withTimeout(
                thenable,
                1000,
                cancellationTokenSource.token
            );

            expect(clearTimeoutSpy).toHaveBeenCalled();
            clearTimeoutSpy.mockRestore();
        });

        it('should cleanup timeout on error', async () => {
            const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');
            const thenable = Promise.reject(new Error('fail'));

            await expect(
                ModelRequestHandler.withTimeout(
                    thenable,
                    1000,
                    cancellationTokenSource.token
                )
            ).rejects.toThrow('fail');

            expect(clearTimeoutSpy).toHaveBeenCalled();
            clearTimeoutSpy.mockRestore();
        });

        it('should suppress late rejections from thenable after timeout', async () => {
            // Track unhandled rejections
            let unhandledRejection = false;
            const handler = () => {
                unhandledRejection = true;
            };
            process.on('unhandledRejection', handler);

            // Create a thenable that rejects after the timeout
            let rejectThenable: (reason: any) => void;
            const thenable = new Promise<string>((_, reject) => {
                rejectThenable = reject;
            });

            // Race with timeout
            const promise = ModelRequestHandler.withTimeout(
                thenable,
                10, // Very short timeout
                cancellationTokenSource.token
            );

            // Wait for timeout
            await expect(promise).rejects.toSatisfy((error: unknown) =>
                isTimeoutError(error)
            );

            // Now reject the thenable after timeout has won
            rejectThenable!(new Error('Late rejection'));

            // Give event loop time to process the rejection
            await new Promise((resolve) => setTimeout(resolve, 50));

            // Should not have caused an unhandled rejection
            expect(unhandledRejection).toBe(false);

            process.off('unhandledRejection', handler);
        });
    });

    describe('sendRequest', () => {
        it('should successfully send request and parse text response', async () => {
            const mockStream = {
                async *[Symbol.asyncIterator]() {
                    yield new vscode.LanguageModelTextPart('Hello, world!');
                },
            };

            mockModel.sendRequest.mockResolvedValue({ stream: mockStream });

            const request: ToolCallRequest = {
                messages: [{ role: 'user', content: 'test' }],
                tools: [],
            };

            const response = await ModelRequestHandler.sendRequest(
                mockModel,
                request,
                cancellationTokenSource.token,
                5000
            );

            expect(response.content).toBe('Hello, world!');
            expect(response.toolCalls).toBeUndefined();
        });

        it('should parse tool calls from response stream', async () => {
            const mockStream = {
                async *[Symbol.asyncIterator]() {
                    yield new vscode.LanguageModelToolCallPart(
                        'call-456',
                        'readFile',
                        { path: '/test.ts' }
                    );
                },
            };

            mockModel.sendRequest.mockResolvedValue({ stream: mockStream });

            const request: ToolCallRequest = {
                messages: [{ role: 'user', content: 'test' }],
                tools: [],
            };

            const response = await ModelRequestHandler.sendRequest(
                mockModel,
                request,
                cancellationTokenSource.token,
                5000
            );

            expect(response.toolCalls).toBeDefined();
            expect(response.toolCalls).toHaveLength(1);
            expect(response.toolCalls![0].id).toBe('call-456');
            expect(response.toolCalls![0].function.name).toBe('readFile');
            expect(response.toolCalls![0].function.arguments).toBe(
                JSON.stringify({ path: '/test.ts' })
            );
        });

        it('should handle mixed text and tool call response', async () => {
            const mockStream = {
                async *[Symbol.asyncIterator]() {
                    yield new vscode.LanguageModelTextPart(
                        'Let me read that file.'
                    );
                    yield new vscode.LanguageModelToolCallPart(
                        'call-789',
                        'readFile',
                        { path: '/example.ts' }
                    );
                },
            };

            mockModel.sendRequest.mockResolvedValue({ stream: mockStream });

            const request: ToolCallRequest = {
                messages: [{ role: 'user', content: 'test' }],
                tools: [],
            };

            const response = await ModelRequestHandler.sendRequest(
                mockModel,
                request,
                cancellationTokenSource.token,
                5000
            );

            expect(response.content).toBe('Let me read that file.');
            expect(response.toolCalls).toHaveLength(1);
            expect(response.toolCalls![0].function.name).toBe('readFile');
        });

        it('should handle multiple tool calls in response', async () => {
            const mockStream = {
                async *[Symbol.asyncIterator]() {
                    yield new vscode.LanguageModelToolCallPart(
                        'call-1',
                        'readFile',
                        { path: '/file1.ts' }
                    );
                    yield new vscode.LanguageModelToolCallPart(
                        'call-2',
                        'findSymbol',
                        { name: 'MyClass' }
                    );
                },
            };

            mockModel.sendRequest.mockResolvedValue({ stream: mockStream });

            const request: ToolCallRequest = {
                messages: [{ role: 'user', content: 'test' }],
                tools: [],
            };

            const response = await ModelRequestHandler.sendRequest(
                mockModel,
                request,
                cancellationTokenSource.token,
                5000
            );

            expect(response.toolCalls).toHaveLength(2);
            expect(response.toolCalls![0].function.name).toBe('readFile');
            expect(response.toolCalls![1].function.name).toBe('findSymbol');
        });

        it('should timeout after specified duration', async () => {
            // Mock a request that never resolves
            mockModel.sendRequest.mockImplementation(
                () => new Promise(() => {})
            );

            const request: ToolCallRequest = {
                messages: [{ role: 'user', content: 'test' }],
                tools: [],
            };

            await expect(
                ModelRequestHandler.sendRequest(
                    mockModel,
                    request,
                    cancellationTokenSource.token,
                    50 // 50ms timeout
                )
            ).rejects.toSatisfy((error: unknown) => isTimeoutError(error));
        }, 1000);

        it('should timeout when stream consumption stalls', async () => {
            // Mock a stream that stalls during iteration
            const mockStream = {
                async *[Symbol.asyncIterator]() {
                    yield new vscode.LanguageModelTextPart('First chunk');
                    // Stall indefinitely - simulating poor network
                    await new Promise(() => {});
                },
            };

            mockModel.sendRequest.mockResolvedValue({ stream: mockStream });

            const request: ToolCallRequest = {
                messages: [{ role: 'user', content: 'test' }],
                tools: [],
            };

            await expect(
                ModelRequestHandler.sendRequest(
                    mockModel,
                    request,
                    cancellationTokenSource.token,
                    50 // 50ms timeout should catch the stalled stream
                )
            ).rejects.toSatisfy((error: unknown) => isTimeoutError(error));
        }, 1000);

        it('should cancel during stream consumption when token fires', async () => {
            let yieldCount = 0;

            // Mock a stream that yields slowly
            const mockStream = {
                async *[Symbol.asyncIterator]() {
                    while (yieldCount < 10) {
                        yieldCount++;
                        yield new vscode.LanguageModelTextPart(
                            `Chunk ${yieldCount}`
                        );
                        await new Promise((resolve) => setTimeout(resolve, 20));
                    }
                },
            };

            mockModel.sendRequest.mockResolvedValue({ stream: mockStream });

            const request: ToolCallRequest = {
                messages: [{ role: 'user', content: 'test' }],
                tools: [],
            };

            // Cancel after 30ms - should stop after a few chunks
            setTimeout(() => cancellationTokenSource.cancel(), 30);

            await expect(
                ModelRequestHandler.sendRequest(
                    mockModel,
                    request,
                    cancellationTokenSource.token,
                    5000 // Long timeout - cancellation should trigger first
                )
            ).rejects.toThrow();

            // Should have processed only a few chunks before cancellation
            expect(yieldCount).toBeLessThan(10);
        }, 1000);

        it('should propagate errors from model', async () => {
            mockModel.sendRequest.mockRejectedValue(
                new Error('Model unavailable')
            );

            const request: ToolCallRequest = {
                messages: [{ role: 'user', content: 'test' }],
                tools: [],
            };

            await expect(
                ModelRequestHandler.sendRequest(
                    mockModel,
                    request,
                    cancellationTokenSource.token,
                    5000
                )
            ).rejects.toThrow('Model unavailable');
        });

        it('should return null content when response is empty', async () => {
            const mockStream = {
                async *[Symbol.asyncIterator]() {
                    // Empty stream
                },
            };

            mockModel.sendRequest.mockResolvedValue({ stream: mockStream });

            const request: ToolCallRequest = {
                messages: [{ role: 'user', content: 'test' }],
                tools: [],
            };

            const response = await ModelRequestHandler.sendRequest(
                mockModel,
                request,
                cancellationTokenSource.token,
                5000
            );

            expect(response.content).toBeNull();
            expect(response.toolCalls).toBeUndefined();
        });

        it('should pass tools to model request options', async () => {
            const mockStream = {
                async *[Symbol.asyncIterator]() {
                    yield new vscode.LanguageModelTextPart('Response');
                },
            };

            mockModel.sendRequest.mockResolvedValue({ stream: mockStream });

            const mockTool = {
                name: 'testTool',
                description: 'A test tool',
                inputSchema: { type: 'object' },
            };

            const request: ToolCallRequest = {
                messages: [{ role: 'user', content: 'test' }],
                tools: [mockTool as any],
            };

            await ModelRequestHandler.sendRequest(
                mockModel,
                request,
                cancellationTokenSource.token,
                5000
            );

            expect(mockModel.sendRequest).toHaveBeenCalledWith(
                expect.any(Array), // messages
                expect.objectContaining({ tools: [mockTool] }), // options
                expect.any(Object) // linked CancellationToken (not the original)
            );
        });

        it('should concatenate multiple text chunks', async () => {
            const mockStream = {
                async *[Symbol.asyncIterator]() {
                    yield new vscode.LanguageModelTextPart('Hello, ');
                    yield new vscode.LanguageModelTextPart('world');
                    yield new vscode.LanguageModelTextPart('!');
                },
            };

            mockModel.sendRequest.mockResolvedValue({ stream: mockStream });

            const request: ToolCallRequest = {
                messages: [{ role: 'user', content: 'test' }],
                tools: [],
            };

            const response = await ModelRequestHandler.sendRequest(
                mockModel,
                request,
                cancellationTokenSource.token,
                5000
            );

            expect(response.content).toBe('Hello, world!');
        });

        it('should actively stop stream consumption on timeout (no resource leak)', async () => {
            // This test verifies that when timeout fires, the stream consumer
            // actually stops iterating, preventing resource leaks.
            let yieldCount = 0;
            let streamExited = false;

            // Mock a stream that yields slowly but would continue forever
            const mockStream = {
                async *[Symbol.asyncIterator]() {
                    try {
                        while (yieldCount < 100) {
                            yieldCount++;
                            yield new vscode.LanguageModelTextPart(
                                `Chunk ${yieldCount}`
                            );
                            // Each chunk takes 30ms, timeout is 50ms
                            await new Promise((resolve) =>
                                setTimeout(resolve, 30)
                            );
                        }
                    } finally {
                        // This runs when the iterator is aborted
                        streamExited = true;
                    }
                },
            };

            mockModel.sendRequest.mockResolvedValue({ stream: mockStream });

            const request: ToolCallRequest = {
                messages: [{ role: 'user', content: 'test' }],
                tools: [],
            };

            // Short timeout - should trigger before stream finishes
            await expect(
                ModelRequestHandler.sendRequest(
                    mockModel,
                    request,
                    cancellationTokenSource.token,
                    50
                )
            ).rejects.toSatisfy((error: unknown) => isTimeoutError(error));

            // Wait a bit for the stream to be cleaned up
            await new Promise((resolve) => setTimeout(resolve, 100));

            // Stream should have exited (not continuing in background)
            expect(streamExited).toBe(true);
            // Should have processed only a few chunks before timeout cancelled it
            expect(yieldCount).toBeLessThan(10);
        }, 2000);
    });
});
