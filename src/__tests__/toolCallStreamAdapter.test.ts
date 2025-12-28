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
            onMarkdown: vi.fn(),
        };
        adapter = new ToolCallStreamAdapter(mockChatHandler);
    });

    describe('onIterationStart', () => {
        it('should NOT emit progress (turn indicators removed for cleaner UX)', () => {
            adapter.onIterationStart(1, 10);
            expect(mockChatHandler.onProgress).not.toHaveBeenCalled();
        });

        it('should be a no-op for any iteration values', () => {
            adapter.onIterationStart(5, 20);
            adapter.onIterationStart(100, 100);
            expect(mockChatHandler.onProgress).not.toHaveBeenCalled();
        });
    });

    describe('onToolCallStart', () => {
        it('should forward to onProgress and onToolStart with tool name and args', () => {
            adapter.onToolCallStart(
                'find_symbol',
                { name_path: 'MyClass' },
                0,
                3
            );

            expect(mockChatHandler.onProgress).toHaveBeenCalledWith(
                `${ACTIVITY.searching} Finding symbol \`MyClass\`...`
            );
            expect(mockChatHandler.onToolStart).toHaveBeenCalledWith(
                'find_symbol',
                { name_path: 'MyClass' }
            );
        });

        it('should format read_file message with file path', () => {
            adapter.onToolCallStart(
                'read_file',
                { file_path: 'src/index.ts' },
                0,
                1
            );

            expect(mockChatHandler.onProgress).toHaveBeenCalledWith(
                `${ACTIVITY.reading} Reading src/index.ts...`
            );
        });

        it('should format find_usages message with symbol name', () => {
            adapter.onToolCallStart(
                'find_usages',
                { symbol_name: 'processData' },
                0,
                1
            );

            expect(mockChatHandler.onProgress).toHaveBeenCalledWith(
                `${ACTIVITY.analyzing} Finding usages of \`processData\`...`
            );
        });

        it('should format list_directory message with path', () => {
            adapter.onToolCallStart(
                'list_directory',
                { path: 'src/utils' },
                0,
                1
            );

            expect(mockChatHandler.onProgress).toHaveBeenCalledWith(
                `${ACTIVITY.reading} Listing src/utils...`
            );
        });

        it('should format find_files_by_pattern message', () => {
            adapter.onToolCallStart(
                'find_files_by_pattern',
                { pattern: '*.test.ts' },
                0,
                1
            );

            expect(mockChatHandler.onProgress).toHaveBeenCalledWith(
                `${ACTIVITY.searching} Finding files matching \`*.test.ts\`...`
            );
        });

        it('should format get_symbols_overview message', () => {
            adapter.onToolCallStart(
                'get_symbols_overview',
                { path: 'src/service.ts' },
                0,
                1
            );

            expect(mockChatHandler.onProgress).toHaveBeenCalledWith(
                `${ACTIVITY.analyzing} Getting symbols in src/service.ts...`
            );
        });

        it('should format search_for_pattern message', () => {
            adapter.onToolCallStart(
                'search_for_pattern',
                { pattern: 'TODO:' },
                0,
                1
            );

            expect(mockChatHandler.onProgress).toHaveBeenCalledWith(
                `${ACTIVITY.searching} Searching for \`TODO:\`...`
            );
        });

        it('should format run_subagent message', () => {
            adapter.onToolCallStart(
                'run_subagent',
                { task: 'investigate security' },
                0,
                1
            );

            expect(mockChatHandler.onProgress).toHaveBeenCalledWith(
                '🤖 Spawning subagent investigation...'
            );
        });

        it('should format think_about_context message', () => {
            adapter.onToolCallStart('think_about_context', {}, 0, 1);

            expect(mockChatHandler.onProgress).toHaveBeenCalledWith(
                '🧠 Reflecting on context...'
            );
        });

        it('should format think_about_investigation message', () => {
            adapter.onToolCallStart('think_about_investigation', {}, 0, 1);

            expect(mockChatHandler.onProgress).toHaveBeenCalledWith(
                '🧠 Checking investigation progress...'
            );
        });

        it('should format think_about_task message', () => {
            adapter.onToolCallStart('think_about_task', {}, 0, 1);

            expect(mockChatHandler.onProgress).toHaveBeenCalledWith(
                '🧠 Verifying task alignment...'
            );
        });

        it('should format think_about_completion message', () => {
            adapter.onToolCallStart('think_about_completion', {}, 0, 1);

            expect(mockChatHandler.onProgress).toHaveBeenCalledWith(
                '🧠 Verifying analysis completeness...'
            );
        });

        it('should use default format for unknown tools', () => {
            adapter.onToolCallStart('custom_tool', { foo: 'bar' }, 0, 1);

            expect(mockChatHandler.onProgress).toHaveBeenCalledWith(
                '🔧 Running custom_tool...'
            );
        });

        it('should handle missing args gracefully', () => {
            adapter.onToolCallStart('read_file', {}, 0, 1);

            expect(mockChatHandler.onProgress).toHaveBeenCalledWith(
                `${ACTIVITY.reading} Reading file...`
            );
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
