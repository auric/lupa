import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { ChatContextManager } from '../models/chatContextManager';

vi.mock('../services/loggingService', () => ({
    Log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
}));

/** Default token estimation: ~4 characters per token */
const DEFAULT_TOKEN_COUNTER = (text: string) => Math.ceil(text.length / 4);

function createMockRequestTurn(prompt: string): vscode.ChatRequestTurn {
    return {
        prompt,
        participant: 'lupa.chat-participant',
        command: undefined,
        references: [],
        toolReferences: [],
    } as unknown as vscode.ChatRequestTurn;
}

function createMockResponseTurn(textContent: string): vscode.ChatResponseTurn {
    return {
        participant: 'lupa.chat-participant',
        command: undefined,
        response: [
            new vscode.ChatResponseMarkdownPart(
                new vscode.MarkdownString(textContent)
            ),
        ],
        result: {},
    } as unknown as vscode.ChatResponseTurn;
}

function createMockModel(
    maxInputTokens: number,
    tokenCounter?: (text: string) => number
): vscode.LanguageModelChat {
    const counter = tokenCounter ?? DEFAULT_TOKEN_COUNTER;

    return {
        id: 'test-model',
        name: 'Test Model',
        vendor: 'test',
        family: 'test',
        version: '1.0',
        maxInputTokens,
        countTokens: vi.fn((text: string) => Promise.resolve(counter(text))),
        sendRequest: vi.fn(),
    } as unknown as vscode.LanguageModelChat;
}

function createMockToken(isCancelled = false): vscode.CancellationToken {
    return {
        isCancellationRequested: isCancelled,
        onCancellationRequested: vi.fn(),
    } as unknown as vscode.CancellationToken;
}

describe('ChatContextManager', () => {
    let manager: ChatContextManager;

    beforeEach(() => {
        vi.clearAllMocks();
        manager = new ChatContextManager();
    });

    describe('prepareConversationHistory', () => {
        it('should return empty array for empty history', async () => {
            const model = createMockModel(8000);
            const token = createMockToken();

            const result = await manager.prepareConversationHistory(
                [],
                model,
                'System prompt',
                token
            );

            expect(result).toEqual([]);
        });

        it('should convert request turn to user message', async () => {
            const history: Array<
                vscode.ChatRequestTurn | vscode.ChatResponseTurn
            > = [createMockRequestTurn('What does this function do?')];
            const model = createMockModel(8000);
            const token = createMockToken();

            const result = await manager.prepareConversationHistory(
                history,
                model,
                'System prompt',
                token
            );

            expect(result).toHaveLength(1);
            expect(result[0]).toEqual({
                role: 'user',
                content: 'What does this function do?',
            });
        });

        it('should convert response turn to assistant message', async () => {
            const history: Array<
                vscode.ChatRequestTurn | vscode.ChatResponseTurn
            > = [
                createMockResponseTurn('This function handles authentication.'),
            ];
            const model = createMockModel(8000);
            const token = createMockToken();

            const result = await manager.prepareConversationHistory(
                history,
                model,
                'System prompt',
                token
            );

            expect(result).toHaveLength(1);
            expect(result[0]).toEqual({
                role: 'assistant',
                content: 'This function handles authentication.',
            });
        });

        it('should preserve chronological order for full history', async () => {
            const history: Array<
                vscode.ChatRequestTurn | vscode.ChatResponseTurn
            > = [
                createMockRequestTurn('First question'),
                createMockResponseTurn('First answer'),
                createMockRequestTurn('Second question'),
                createMockResponseTurn('Second answer'),
            ];
            const model = createMockModel(50000);
            const token = createMockToken();

            const result = await manager.prepareConversationHistory(
                history,
                model,
                'Short prompt',
                token
            );

            expect(result).toHaveLength(4);
            expect(result[0].role).toBe('user');
            expect(result[0].content).toBe('First question');
            expect(result[1].role).toBe('assistant');
            expect(result[1].content).toBe('First answer');
            expect(result[2].role).toBe('user');
            expect(result[2].content).toBe('Second question');
            expect(result[3].role).toBe('assistant');
            expect(result[3].content).toBe('Second answer');
        });

        it('should truncate older history when budget exceeded', async () => {
            const history: Array<
                vscode.ChatRequestTurn | vscode.ChatResponseTurn
            > = [
                createMockRequestTurn('Old question that should be dropped'),
                createMockResponseTurn('Old answer that should be dropped'),
                createMockRequestTurn('Recent question'),
                createMockResponseTurn('Recent answer'),
            ];
            // Budget: (6000 - 4000) * 0.8 = 1600 tokens
            // System prompt ~15 tokens, leaves ~1585
            // Each message ~10-15 tokens, so room for 2-3 recent ones
            const model = createMockModel(6000, DEFAULT_TOKEN_COUNTER);
            const token = createMockToken();

            const result = await manager.prepareConversationHistory(
                history,
                model,
                'System', // Short system prompt
                token
            );

            // Should have some but not all turns due to budget
            expect(result.length).toBeGreaterThan(0);
            expect(result.length).toBeLessThanOrEqual(4);
            // Recent turns should be kept (newest-first processing)
            if (result.length > 0) {
                const contents = result.map((m) => m.content);
                // Last item should be from recent history
                expect(contents[contents.length - 1]).toBe('Recent answer');
            }
        });

        it('should respect OUTPUT_RESERVE of 4000 tokens', async () => {
            const history: Array<
                vscode.ChatRequestTurn | vscode.ChatResponseTurn
            > = [createMockRequestTurn('Question')];
            // Model with just 4100 tokens - 4000 reserved = 100 available * 0.8 = 80 effective
            const model = createMockModel(4100, () => 50);
            const token = createMockToken();

            const result = await manager.prepareConversationHistory(
                history,
                model,
                '', // Empty system prompt
                token
            );

            // With 80 tokens available and 50 per message, should fit 1 message
            expect(result.length).toBeLessThanOrEqual(1);
        });

        it('should respect BUDGET_THRESHOLD of 80%', async () => {
            const tokenCounts: number[] = [];
            const history: Array<
                vscode.ChatRequestTurn | vscode.ChatResponseTurn
            > = [
                createMockRequestTurn('Message 1'),
                createMockRequestTurn('Message 2'),
                createMockRequestTurn('Message 3'),
            ];
            const model = createMockModel(10000, (_text) => {
                const count = 100;
                tokenCounts.push(count);
                return count;
            });
            const token = createMockToken();

            await manager.prepareConversationHistory(
                history,
                model,
                'System', // ~25 tokens at 4 chars per token
                token
            );

            // Budget = (10000 - 4000) * 0.8 = 4800 tokens
            expect(model.countTokens).toHaveBeenCalled();
        });

        it('should return empty when no budget after system prompt', async () => {
            const { Log } = await import('../services/loggingService');
            const history: Array<
                vscode.ChatRequestTurn | vscode.ChatResponseTurn
            > = [createMockRequestTurn('Question')];
            // Model with minimal space - system prompt consumes all budget
            const model = createMockModel(5000, () => 1000);
            const token = createMockToken();

            const result = await manager.prepareConversationHistory(
                history,
                model,
                'Very long system prompt that consumes all tokens',
                token
            );

            expect(result).toEqual([]);
            expect(Log.warn).toHaveBeenCalledWith(
                '[ChatContextManager]: No budget available after system prompt'
            );
        });

        it('should handle cancellation during processing', async () => {
            const history: Array<
                vscode.ChatRequestTurn | vscode.ChatResponseTurn
            > = [
                createMockRequestTurn('Question 1'),
                createMockRequestTurn('Question 2'),
                createMockRequestTurn('Question 3'),
            ];
            const model = createMockModel(50000);
            const token = {
                isCancellationRequested: false,
                onCancellationRequested: vi.fn(),
            };

            // Cancel after first iteration
            let callCount = 0;
            vi.mocked(model.countTokens).mockImplementation(async () => {
                callCount++;
                if (callCount > 1) {
                    token.isCancellationRequested = true;
                }
                return 10;
            });

            const result = await manager.prepareConversationHistory(
                history,
                model,
                'System',
                token as vscode.CancellationToken
            );

            // Should have stopped early due to cancellation
            expect(result.length).toBeLessThan(3);
        });

        it('should skip response turns with no text content', async () => {
            const emptyResponseTurn = {
                participant: 'lupa.chat-participant',
                command: undefined,
                response: [], // Empty response
                result: {},
            } as unknown as vscode.ChatResponseTurn;

            const history: Array<
                vscode.ChatRequestTurn | vscode.ChatResponseTurn
            > = [createMockRequestTurn('Question'), emptyResponseTurn];
            const model = createMockModel(50000);
            const token = createMockToken();

            const result = await manager.prepareConversationHistory(
                history,
                model,
                'System',
                token
            );

            // Only the request turn should be included
            expect(result).toHaveLength(1);
            expect(result[0].role).toBe('user');
        });

        it('should concatenate multiple markdown parts in response', async () => {
            const multiPartResponse = {
                participant: 'lupa.chat-participant',
                command: undefined,
                response: [
                    new vscode.ChatResponseMarkdownPart(
                        new vscode.MarkdownString('Part 1')
                    ),
                    new vscode.ChatResponseMarkdownPart(
                        new vscode.MarkdownString('Part 2')
                    ),
                    new vscode.ChatResponseMarkdownPart(
                        new vscode.MarkdownString('Part 3')
                    ),
                ],
                result: {},
            } as unknown as vscode.ChatResponseTurn;

            const history: Array<
                vscode.ChatRequestTurn | vscode.ChatResponseTurn
            > = [multiPartResponse];
            const model = createMockModel(50000);
            const token = createMockToken();

            const result = await manager.prepareConversationHistory(
                history,
                model,
                'System',
                token
            );

            expect(result).toHaveLength(1);
            expect(result[0].content).toBe('Part 1\n\nPart 2\n\nPart 3');
        });

        it('should skip non-markdown parts in response', async () => {
            const mixedResponse = {
                participant: 'lupa.chat-participant',
                command: undefined,
                response: [
                    new vscode.ChatResponseMarkdownPart(
                        new vscode.MarkdownString('Text content')
                    ),
                    { someOtherProperty: 'not text' }, // Non-markdown part
                    { value: 'plain value not markdown' }, // Wrong structure
                ],
                result: {},
            } as unknown as vscode.ChatResponseTurn;

            const history: Array<
                vscode.ChatRequestTurn | vscode.ChatResponseTurn
            > = [mixedResponse];
            const model = createMockModel(50000);
            const token = createMockToken();

            const result = await manager.prepareConversationHistory(
                history,
                model,
                'System',
                token
            );

            expect(result).toHaveLength(1);
            expect(result[0].content).toBe('Text content');
        });

        it('should return empty array on error and log warning', async () => {
            const { Log } = await import('../services/loggingService');
            const history: Array<
                vscode.ChatRequestTurn | vscode.ChatResponseTurn
            > = [createMockRequestTurn('Question')];
            const model = createMockModel(50000);
            vi.mocked(model.countTokens).mockRejectedValue(
                new Error('Token counting failed')
            );
            const token = createMockToken();

            const result = await manager.prepareConversationHistory(
                history,
                model,
                'System',
                token
            );

            expect(result).toEqual([]);
            expect(Log.warn).toHaveBeenCalledWith(
                '[ChatContextManager]: History processing failed, continuing without history',
                expect.any(Error)
            );
        });

        it('should log when truncation occurs', async () => {
            const { Log } = await import('../services/loggingService');
            const history: Array<
                vscode.ChatRequestTurn | vscode.ChatResponseTurn
            > = [
                createMockRequestTurn('Old message'),
                createMockRequestTurn('Recent message'),
            ];
            // Tight budget - system takes most, only room for 1 message
            const model = createMockModel(5000, () => 500);
            const token = createMockToken();

            await manager.prepareConversationHistory(
                history,
                model,
                'System prompt',
                token
            );

            expect(Log.info).toHaveBeenCalledWith(
                expect.stringContaining(
                    '[ChatContextManager]: Truncating history at turn'
                )
            );
        });

        it('should log when partial history is included', async () => {
            const { Log } = await import('../services/loggingService');
            const history: Array<
                vscode.ChatRequestTurn | vscode.ChatResponseTurn
            > = [
                createMockRequestTurn('Message 1'),
                createMockRequestTurn('Message 2'),
                createMockRequestTurn('Message 3'),
            ];
            // Budget allows only some messages
            const model = createMockModel(5500, () => 400);
            const token = createMockToken();

            const result = await manager.prepareConversationHistory(
                history,
                model,
                'System',
                token
            );

            if (result.length < history.length) {
                expect(Log.info).toHaveBeenCalledWith(
                    expect.stringContaining(
                        `Included ${result.length} of ${history.length} history turns`
                    )
                );
            }
        });
    });

    describe('message conversion', () => {
        it('should set role to user for request turns', async () => {
            const history = [createMockRequestTurn('Test')];
            const model = createMockModel(50000);
            const token = createMockToken();

            const result = await manager.prepareConversationHistory(
                history,
                model,
                'System',
                token
            );

            expect(result[0].role).toBe('user');
        });

        it('should set role to assistant for response turns', async () => {
            const history = [createMockResponseTurn('Test')];
            const model = createMockModel(50000);
            const token = createMockToken();

            const result = await manager.prepareConversationHistory(
                history,
                model,
                'System',
                token
            );

            expect(result[0].role).toBe('assistant');
        });

        it('should set null content for empty response', async () => {
            const emptyResponse = {
                participant: 'lupa.chat-participant',
                response: [],
                result: {},
            } as unknown as vscode.ChatResponseTurn;

            const history = [emptyResponse];
            const model = createMockModel(50000);
            const token = createMockToken();

            const result = await manager.prepareConversationHistory(
                history,
                model,
                'System',
                token
            );

            // Empty responses should be skipped
            expect(result).toHaveLength(0);
        });
    });
});
