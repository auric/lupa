import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import { ModelRequestHandler } from '../models/modelRequestHandler';
import type { ToolCallRequest, ToolCallMessage } from '../types/modelTypes';
import { TimeoutError, isTimeoutError } from '../utils/asyncUtils';
import { Log } from '../services/loggingService';

vi.mock('../services/loggingService', () => ({
    Log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    },
}));

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

        it('should reject with TimeoutError if thenable takes too long', async () => {
            // Create a promise that never resolves
            const thenable = new Promise(() => {});

            await expect(
                ModelRequestHandler.withTimeout(
                    thenable,
                    50, // 50ms timeout
                    cancellationTokenSource.token
                )
            ).rejects.toThrow(TimeoutError);
        }, 1000);

        it('should be detectable via isTimeoutError type guard', async () => {
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

        it('should log when abandoned operation completes after timeout', async () => {
            vi.useFakeTimers();
            let resolveThenable: (value: string) => void;
            const thenable = new Promise<string>((resolve) => {
                resolveThenable = resolve;
            });

            const promise = ModelRequestHandler.withTimeout(
                thenable,
                100,
                cancellationTokenSource.token
            );

            // Advance past timeout
            vi.advanceTimersByTime(150);

            await expect(promise).rejects.toThrow(TimeoutError);

            // Now resolve the "abandoned" promise
            resolveThenable!('late result');
            await vi.runAllTimersAsync();

            expect(Log.debug).toHaveBeenCalledWith(
                expect.stringContaining('[Abandoned] LLM request completed')
            );
            vi.useRealTimers();
        });

        it('should log when abandoned operation fails after timeout', async () => {
            vi.useFakeTimers();
            let rejectThenable: (error: Error) => void;
            const thenable = new Promise<string>((_, reject) => {
                rejectThenable = reject;
            });

            const promise = ModelRequestHandler.withTimeout(
                thenable,
                100,
                cancellationTokenSource.token
            );

            // Advance past timeout
            vi.advanceTimersByTime(150);

            await expect(promise).rejects.toThrow(TimeoutError);

            // Now reject the "abandoned" promise
            rejectThenable!(new Error('Late error'));
            await vi.runAllTimersAsync();

            expect(Log.debug).toHaveBeenCalledWith(
                expect.stringContaining('[Abandoned] LLM request failed')
            );
            vi.useRealTimers();
        });

        it('should not log abandoned when operation completes before timeout', async () => {
            vi.clearAllMocks();
            const thenable = Promise.resolve('success');

            const result = await ModelRequestHandler.withTimeout(
                thenable,
                1000,
                cancellationTokenSource.token
            );

            expect(result).toBe('success');
            expect(Log.debug).not.toHaveBeenCalledWith(
                expect.stringContaining('[Abandoned]')
            );
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
            ).rejects.toThrow(TimeoutError);
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
                cancellationTokenSource.token
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

        it('should timeout if stream consumption exceeds timeout (stalled stream)', async () => {
            // Mock a stream that starts yielding but then stalls beyond timeout
            const mockStream = {
                async *[Symbol.asyncIterator]() {
                    yield new vscode.LanguageModelTextPart('First chunk');
                    // Simulate a stalled stream - wait longer than timeout
                    await new Promise((resolve) => setTimeout(resolve, 200));
                    yield new vscode.LanguageModelTextPart('Never received');
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
                    100 // 100ms timeout - stream stalls for 200ms
                )
            ).rejects.toThrow(TimeoutError);

            // Verify the error details
            try {
                await ModelRequestHandler.sendRequest(
                    mockModel,
                    request,
                    cancellationTokenSource.token,
                    100
                );
            } catch (error) {
                expect(isTimeoutError(error)).toBe(true);
                expect((error as TimeoutError).operation).toBe(
                    'LLM stream consumption'
                );
            }
        }, 2000);
    });
});
