import { describe, it, expect, vi, beforeEach, Mock } from 'vitest';
import { TokenValidator } from '../models/tokenValidator';
import { TokenConstants } from '../models/tokenConstants';
import type { ToolCallMessage } from '../types/modelTypes';

// Mock VS Code
vi.mock('vscode');

describe('TokenValidator', () => {
    let mockModel: {
        countTokens: Mock;
        maxInputTokens: number;
    };
    let tokenValidator: TokenValidator;

    beforeEach(() => {
        mockModel = {
            countTokens: vi.fn(),
            maxInputTokens: 8000,
        };
        tokenValidator = new TokenValidator(mockModel as any);
    });

    describe('validateTokens', () => {
        it('should return continue action when tokens are within safe limits', async () => {
            const systemPrompt = 'You are a helpful assistant';
            const messages: ToolCallMessage[] = [
                {
                    role: 'user',
                    content: 'Hello',
                    toolCalls: undefined,
                    toolCallId: undefined,
                },
            ];

            // Mock token counts: system=100, user=50, total=150 (well under 90% of 8000)
            mockModel.countTokens
                .mockResolvedValueOnce(100) // system prompt
                .mockResolvedValueOnce(50); // user message

            const result = await tokenValidator.validateTokens(
                messages,
                systemPrompt
            );

            expect(result.suggestedAction).toBe('continue');
            expect(result.exceedsWarningThreshold).toBe(false);
            expect(result.exceedsMaxTokens).toBe(false);
            expect(result.totalTokens).toBe(155); // 100 + 50 + TOKEN_OVERHEAD_PER_MESSAGE
        });

        it('should return remove_old_context action when exceeding warning threshold', async () => {
            const systemPrompt = 'You are a helpful assistant';
            const messages: ToolCallMessage[] = [
                {
                    role: 'user',
                    content: 'Long message...',
                    toolCalls: undefined,
                    toolCallId: undefined,
                },
            ];

            // Mock token counts to exceed 90% of 8000 (7200)
            mockModel.countTokens
                .mockResolvedValueOnce(100) // system prompt
                .mockResolvedValueOnce(7205); // user message (total will be 7305)

            const result = await tokenValidator.validateTokens(
                messages,
                systemPrompt
            );

            expect(result.suggestedAction).toBe('remove_old_context');
            expect(result.exceedsWarningThreshold).toBe(true);
            expect(result.exceedsMaxTokens).toBe(false);
        });

        it('should return request_final_answer action when exceeding max tokens', async () => {
            const systemPrompt = 'You are a helpful assistant';
            const messages: ToolCallMessage[] = [
                {
                    role: 'user',
                    content: 'Very long message...',
                    toolCalls: undefined,
                    toolCallId: undefined,
                },
            ];

            // Mock token counts to exceed 8000
            mockModel.countTokens
                .mockResolvedValueOnce(100) // system prompt
                .mockResolvedValueOnce(8000); // user message (total will be 8105)

            const result = await tokenValidator.validateTokens(
                messages,
                systemPrompt
            );

            expect(result.suggestedAction).toBe('request_final_answer');
            expect(result.exceedsMaxTokens).toBe(true);
        });

        it('should handle tool calls in token counting', async () => {
            const systemPrompt = 'You are a helpful assistant';
            const toolCalls = [
                {
                    id: 'call_1',
                    function: {
                        name: 'test_tool',
                        arguments: '{"param": "value"}',
                    },
                },
            ];
            const messages: ToolCallMessage[] = [
                {
                    role: 'assistant',
                    content: 'I will use a tool',
                    toolCalls,
                    toolCallId: undefined,
                },
            ];

            mockModel.countTokens
                .mockResolvedValueOnce(100) // system prompt
                .mockResolvedValueOnce(50) // assistant message content
                .mockResolvedValueOnce(20); // tool call JSON

            const result = await tokenValidator.validateTokens(
                messages,
                systemPrompt
            );

            expect(result.totalTokens).toBe(175); // 100 + 50 + 20 + TOKEN_OVERHEAD_PER_MESSAGE
            expect(mockModel.countTokens).toHaveBeenCalledTimes(3);
        });

        it('should handle errors gracefully', async () => {
            const systemPrompt = 'You are a helpful assistant';
            const messages: ToolCallMessage[] = [
                {
                    role: 'user',
                    content: 'Hello',
                    toolCalls: undefined,
                    toolCallId: undefined,
                },
            ];

            mockModel.countTokens.mockRejectedValue(new Error('API Error'));

            const result = await tokenValidator.validateTokens(
                messages,
                systemPrompt
            );

            expect(result.suggestedAction).toBe('continue');
            expect(result.totalTokens).toBe(0);
        });
    });

    describe('cleanupContext', () => {
        it('should remove oldest tool interactions when over target', async () => {
            const systemPrompt = 'You are a helpful assistant';
            const messages: ToolCallMessage[] = [
                {
                    role: 'user',
                    content: 'Initial request',
                    toolCalls: undefined,
                    toolCallId: undefined,
                },
                {
                    role: 'assistant',
                    content: 'I will call a tool',
                    toolCalls: [
                        {
                            id: 'call_1',
                            function: { name: 'tool1', arguments: '{}' },
                        },
                    ],
                    toolCallId: undefined,
                },
                {
                    role: 'tool',
                    content: 'Tool result 1',
                    toolCalls: undefined,
                    toolCallId: 'call_1',
                },
                {
                    role: 'assistant',
                    content: 'I will call another tool',
                    toolCalls: [
                        {
                            id: 'call_2',
                            function: { name: 'tool2', arguments: '{}' },
                        },
                    ],
                    toolCallId: undefined,
                },
                {
                    role: 'tool',
                    content: 'Tool result 2',
                    toolCalls: undefined,
                    toolCallId: 'call_2',
                },
                {
                    role: 'user',
                    content: 'Final request',
                    toolCalls: undefined,
                    toolCallId: undefined,
                },
            ];

            // Mock high token counts to trigger cleanup
            mockModel.countTokens.mockImplementation(async (text: string) => {
                if (text.includes('system')) {
                    return 100;
                }
                return 1000; // High count to trigger cleanup
            });

            const result = await tokenValidator.cleanupContext(
                messages,
                systemPrompt,
                0.5
            );

            expect(result.toolResultsRemoved).toBeGreaterThan(0);
            expect(result.contextFullMessageAdded).toBe(true);
            expect(result.cleanedMessages.length).toBeLessThan(messages.length);

            // Should have context full message at the end
            const lastMessage =
                result.cleanedMessages[result.cleanedMessages.length - 1];
            expect(lastMessage.role).toBe('user');
            expect(lastMessage.content).toBe(
                TokenConstants.TOOL_CONTEXT_MESSAGES.CONTEXT_FULL
            );
        });

        it('should not modify messages when under target utilization', async () => {
            const systemPrompt = 'You are a helpful assistant';
            const messages: ToolCallMessage[] = [
                {
                    role: 'user',
                    content: 'Hello',
                    toolCalls: undefined,
                    toolCallId: undefined,
                },
            ];

            // Mock low token counts
            mockModel.countTokens.mockResolvedValue(50);

            const result = await tokenValidator.cleanupContext(
                messages,
                systemPrompt,
                0.8
            );

            expect(result.toolResultsRemoved).toBe(0);
            expect(result.assistantMessagesRemoved).toBe(0);
            expect(result.contextFullMessageAdded).toBe(false);
            expect(result.cleanedMessages).toEqual(messages);
        });

        it('should handle cleanup errors gracefully', async () => {
            const systemPrompt = 'You are a helpful assistant';
            const messages: ToolCallMessage[] = [
                {
                    role: 'user',
                    content: 'Hello',
                    toolCalls: undefined,
                    toolCallId: undefined,
                },
            ];

            mockModel.countTokens.mockRejectedValue(new Error('API Error'));

            const result = await tokenValidator.cleanupContext(
                messages,
                systemPrompt,
                0.8
            );

            // Should return original messages on error
            expect(result.cleanedMessages).toEqual(messages);
            expect(result.toolResultsRemoved).toBe(0);
            expect(result.contextFullMessageAdded).toBe(false);
        });
    });

    describe('isResponseSizeAcceptable', () => {
        it('should return true for responses within limit', () => {
            const shortResponse = 'A'.repeat(1000);
            expect(tokenValidator.isResponseSizeAcceptable(shortResponse)).toBe(
                true
            );
        });

        it('should return false for responses exceeding limit', () => {
            const longResponse = 'A'.repeat(
                TokenConstants.MAX_TOOL_RESPONSE_CHARS + 1
            );
            expect(tokenValidator.isResponseSizeAcceptable(longResponse)).toBe(
                false
            );
        });

        it('should handle responses exactly at the limit', () => {
            const exactResponse = 'A'.repeat(
                TokenConstants.MAX_TOOL_RESPONSE_CHARS
            );
            expect(tokenValidator.isResponseSizeAcceptable(exactResponse)).toBe(
                true
            );
        });
    });

    describe('removeOldestToolInteraction', () => {
        it('should correctly match tool results with assistant messages', async () => {
            const messages: ToolCallMessage[] = [
                {
                    role: 'user',
                    content: 'Initial request',
                    toolCalls: undefined,
                    toolCallId: undefined,
                },
                {
                    role: 'assistant',
                    content: 'I will call tool1',
                    toolCalls: [
                        {
                            id: 'call_1',
                            function: { name: 'tool1', arguments: '{}' },
                        },
                    ],
                    toolCallId: undefined,
                },
                {
                    role: 'tool',
                    content: 'Tool1 result',
                    toolCalls: undefined,
                    toolCallId: 'call_1',
                },
                {
                    role: 'assistant',
                    content: 'I will call tool2',
                    toolCalls: [
                        {
                            id: 'call_2',
                            function: { name: 'tool2', arguments: '{}' },
                        },
                    ],
                    toolCallId: undefined,
                },
                {
                    role: 'tool',
                    content: 'Tool2 result',
                    toolCalls: undefined,
                    toolCallId: 'call_2',
                },
            ];

            // Use private method via type assertion for testing
            const result = (tokenValidator as any).removeOldestToolInteraction(
                messages
            );

            expect(result.found).toBe(true);
            expect(result.toolResultsRemoved).toBe(1);
            expect(result.assistantMessagesRemoved).toBe(1);

            // Should remove the first tool interaction (call_1)
            const remainingMessages = result.messages;
            expect(remainingMessages).not.toContainEqual(
                expect.objectContaining({ toolCallId: 'call_1' })
            );
            expect(remainingMessages).not.toContainEqual(
                expect.objectContaining({
                    role: 'assistant',
                    toolCalls: expect.arrayContaining([
                        expect.objectContaining({ id: 'call_1' }),
                    ]),
                })
            );
        });

        it('should return not found when no tool results exist', async () => {
            const messages: ToolCallMessage[] = [
                {
                    role: 'user',
                    content: 'Hello',
                    toolCalls: undefined,
                    toolCallId: undefined,
                },
                {
                    role: 'assistant',
                    content: 'Hello back',
                    toolCalls: undefined,
                    toolCallId: undefined,
                },
            ];

            const result = (tokenValidator as any).removeOldestToolInteraction(
                messages
            );

            expect(result.found).toBe(false);
            expect(result.toolResultsRemoved).toBe(0);
            expect(result.assistantMessagesRemoved).toBe(0);
            expect(result.messages).toEqual(messages);
        });

        it('should remove ALL tool results when assistant has multiple tool calls', async () => {
            // BUG TEST: When an assistant makes multiple tool calls in one message,
            // removing the oldest tool interaction should remove ALL tool results
            // from that assistant message, not just one
            const messages: ToolCallMessage[] = [
                {
                    role: 'user',
                    content: 'Initial request',
                    toolCalls: undefined,
                    toolCallId: undefined,
                },
                {
                    role: 'assistant',
                    content: 'I will call multiple tools',
                    toolCalls: [
                        {
                            id: 'call_1',
                            function: { name: 'tool1', arguments: '{}' },
                        },
                        {
                            id: 'call_2',
                            function: { name: 'tool2', arguments: '{}' },
                        },
                        {
                            id: 'call_3',
                            function: { name: 'tool3', arguments: '{}' },
                        },
                    ],
                    toolCallId: undefined,
                },
                {
                    role: 'tool',
                    content: 'Tool1 result',
                    toolCalls: undefined,
                    toolCallId: 'call_1',
                },
                {
                    role: 'tool',
                    content: 'Tool2 result',
                    toolCalls: undefined,
                    toolCallId: 'call_2',
                },
                {
                    role: 'tool',
                    content: 'Tool3 result',
                    toolCalls: undefined,
                    toolCallId: 'call_3',
                },
                {
                    role: 'user',
                    content: 'Follow up',
                    toolCalls: undefined,
                    toolCallId: undefined,
                },
            ];

            const result = (tokenValidator as any).removeOldestToolInteraction(
                messages
            );

            expect(result.found).toBe(true);
            // Should remove ALL 3 tool results and the 1 assistant message
            expect(result.toolResultsRemoved).toBe(3);
            expect(result.assistantMessagesRemoved).toBe(1);

            // Remaining messages should only be the user messages
            const remainingMessages = result.messages;
            expect(remainingMessages.length).toBe(2);
            expect(remainingMessages[0].role).toBe('user');
            expect(remainingMessages[0].content).toBe('Initial request');
            expect(remainingMessages[1].role).toBe('user');
            expect(remainingMessages[1].content).toBe('Follow up');

            // No orphaned tool results should exist
            const orphanedToolResults = remainingMessages.filter(
                (m: ToolCallMessage) => m.role === 'tool'
            );
            expect(orphanedToolResults.length).toBe(0);
        });
    });
});
