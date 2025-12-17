import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolCallStreamAdapter } from '../models/toolCallStreamAdapter';
import type { ChatToolCallHandler } from '../types/chatTypes';
import { ACTIVITY } from '../config/chatEmoji';

describe('ToolCallStreamAdapter', () => {
    let mockChatHandler: ChatToolCallHandler;
    let adapter: ToolCallStreamAdapter;

    beforeEach(() => {
        mockChatHandler = {
            onProgress: vi.fn(),
            onToolStart: vi.fn(),
            onToolComplete: vi.fn(),
            onFileReference: vi.fn(),
            onThinking: vi.fn(),
            onMarkdown: vi.fn()
        };
        adapter = new ToolCallStreamAdapter(mockChatHandler);
    });

    describe('onIterationStart', () => {
        it('should forward to onProgress with turn count and thinking emoji', () => {
            adapter.onIterationStart(1, 10);

            expect(mockChatHandler.onProgress).toHaveBeenCalledWith(
                `Turn 1/10: ${ACTIVITY.thinking} Analyzing...`
            );
        });

        it('should handle different iteration numbers', () => {
            adapter.onIterationStart(5, 20);

            expect(mockChatHandler.onProgress).toHaveBeenCalledWith(
                `Turn 5/20: ${ACTIVITY.thinking} Analyzing...`
            );
        });
    });

    describe('onToolCallStart', () => {
        it('should forward to onToolStart with tool name', () => {
            adapter.onToolCallStart('find_symbol', 0, 3);

            expect(mockChatHandler.onToolStart).toHaveBeenCalledWith('find_symbol', {});
        });

        it('should ignore tool index and total tools', () => {
            adapter.onToolCallStart('read_file', 2, 5);

            expect(mockChatHandler.onToolStart).toHaveBeenCalledWith('read_file', {});
            expect(mockChatHandler.onToolStart).toHaveBeenCalledTimes(1);
        });
    });

    describe('onToolCallComplete', () => {
        it('should forward success to onToolComplete with "completed" summary', () => {
            adapter.onToolCallComplete(
                'call_123',
                'find_symbol',
                { name: 'test' },
                'result data',
                true,
                undefined,
                100,
                undefined
            );

            expect(mockChatHandler.onToolComplete).toHaveBeenCalledWith(
                'find_symbol',
                true,
                'completed'
            );
        });

        it('should forward failure with error message as summary', () => {
            adapter.onToolCallComplete(
                'call_456',
                'read_file',
                { path: '/test' },
                '',
                false,
                'File not found',
                50,
                undefined
            );

            expect(mockChatHandler.onToolComplete).toHaveBeenCalledWith(
                'read_file',
                false,
                'File not found'
            );
        });

        it('should use "failed" as summary when no error message provided', () => {
            adapter.onToolCallComplete(
                'call_789',
                'search_pattern',
                {},
                '',
                false,
                undefined,
                0,
                undefined
            );

            expect(mockChatHandler.onToolComplete).toHaveBeenCalledWith(
                'search_pattern',
                false,
                'failed'
            );
        });

        it('should ignore duration and metadata parameters', () => {
            const metadata = { nestedToolCalls: [] };
            adapter.onToolCallComplete(
                'call_test',
                'get_symbols',
                {},
                'symbols',
                true,
                undefined,
                250,
                metadata
            );

            expect(mockChatHandler.onToolComplete).toHaveBeenCalledWith(
                'get_symbols',
                true,
                'completed'
            );
        });
    });
});
