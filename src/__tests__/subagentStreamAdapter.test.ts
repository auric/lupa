import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SubagentStreamAdapter } from '../models/subagentStreamAdapter';
import type { ChatToolCallHandler } from '../types/chatTypes';
import { ACTIVITY } from '../config/chatEmoji';

describe('SubagentStreamAdapter', () => {
    let mockChatHandler: ChatToolCallHandler;
    let adapter: SubagentStreamAdapter;

    beforeEach(() => {
        mockChatHandler = {
            onProgress: vi.fn(),
            onToolStart: vi.fn(),
            onToolComplete: vi.fn(),
            onFileReference: vi.fn(),
            onThinking: vi.fn(),
            onMarkdown: vi.fn(),
        };
        adapter = new SubagentStreamAdapter(mockChatHandler, 1);
    });

    describe('onIterationStart', () => {
        it('should suppress iteration messages for subagents', () => {
            adapter.onIterationStart(1, 10);
            adapter.onIterationStart(5, 20);

            expect(mockChatHandler.onProgress).not.toHaveBeenCalled();
        });
    });

    describe('onToolCallStart', () => {
        it('should prefix markdown messages with subagent indicator for file tools', () => {
            adapter.onToolCallStart(
                'read_file',
                { file_path: 'src/auth.ts' },
                0,
                1
            );

            // File-based tools use markdown with prefix
            expect(mockChatHandler.onMarkdown).toHaveBeenCalledWith(
                `🔹 #1: ${ACTIVITY.reading} Reading `
            );
            expect(mockChatHandler.onFileReference).toHaveBeenCalledWith(
                'src/auth.ts'
            );
        });

        it('should prefix progress messages with subagent indicator for non-file tools', () => {
            adapter.onToolCallStart(
                'find_symbol',
                { name_path: 'login' },
                0,
                1
            );

            expect(mockChatHandler.onProgress).toHaveBeenCalledWith(
                `🔹 #1: ${ACTIVITY.searching} Finding symbol \`login\`...`
            );
        });

        it('should use correct subagent number in prefix for different adapters', () => {
            const adapter2 = new SubagentStreamAdapter(mockChatHandler, 2);
            const adapter3 = new SubagentStreamAdapter(mockChatHandler, 3);

            // Non-file tool uses progress
            adapter2.onToolCallStart(
                'find_symbol',
                { name_path: 'login' },
                0,
                1
            );

            expect(mockChatHandler.onProgress).toHaveBeenCalledWith(
                `🔹 #2: ${ACTIVITY.searching} Finding symbol \`login\`...`
            );

            // File tool uses markdown
            adapter3.onToolCallStart(
                'list_directory',
                { relative_path: 'src' },
                0,
                1
            );

            expect(mockChatHandler.onMarkdown).toHaveBeenCalledWith(
                `🔹 #3: ${ACTIVITY.reading} Listing `
            );
        });

        it('should still emit file references for file-based tools', () => {
            adapter.onToolCallStart(
                'read_file',
                { file_path: 'src/index.ts' },
                0,
                1
            );

            expect(mockChatHandler.onFileReference).toHaveBeenCalledWith(
                'src/index.ts'
            );
        });

        it('should delegate onToolStart without modification', () => {
            const args = { file_path: 'test.ts' };
            adapter.onToolCallStart('read_file', args, 0, 1);

            expect(mockChatHandler.onToolStart).toHaveBeenCalledWith(
                'read_file',
                args
            );
        });
    });

    describe('onToolCallComplete', () => {
        it('should delegate to inner adapter without prefix', () => {
            adapter.onToolCallComplete(
                'call_123',
                'read_file',
                { file_path: 'test.ts' },
                'file content',
                true,
                undefined,
                100
            );

            expect(mockChatHandler.onToolComplete).toHaveBeenCalledWith(
                'read_file',
                true,
                'completed'
            );
        });

        it('should forward failure with error message', () => {
            adapter.onToolCallComplete(
                'call_456',
                'read_file',
                {},
                '',
                false,
                'File not found',
                50
            );

            expect(mockChatHandler.onToolComplete).toHaveBeenCalledWith(
                'read_file',
                false,
                'File not found'
            );
        });
    });

    describe('visual distinction', () => {
        it('should provide clear visual distinction for file-based tools via markdown', () => {
            // Main agent would show: "📂 Reading " + [anchor] + "..."
            // Subagent should show: "🔹 #1: 📂 Reading " + [anchor] + "..."
            adapter.onToolCallStart(
                'read_file',
                { file_path: 'src/index.ts' },
                0,
                1
            );

            const markdownCall = (
                mockChatHandler.onMarkdown as ReturnType<typeof vi.fn>
            ).mock.calls[0][0];
            expect(markdownCall).toMatch(/^🔹 #\d+: /);
        });

        it('should provide clear visual distinction for non-file tools via progress', () => {
            adapter.onToolCallStart('think_about_context', {}, 0, 1);

            const progressCall = (
                mockChatHandler.onProgress as ReturnType<typeof vi.fn>
            ).mock.calls[0][0];
            expect(progressCall).toMatch(/^🔹 #\d+: /);
        });

        it('should format non-file tool types with subagent prefix', () => {
            adapter.onToolCallStart(
                'find_symbol',
                { name_path: 'MyClass' },
                0,
                1
            );
            adapter.onToolCallStart(
                'find_usages',
                { symbol_name: 'login' },
                1,
                2
            );
            adapter.onToolCallStart(
                'search_for_pattern',
                { pattern: 'TODO' },
                0,
                1
            );

            const calls = (
                mockChatHandler.onProgress as ReturnType<typeof vi.fn>
            ).mock.calls;
            expect(calls).toHaveLength(3);
            expect(calls[0][0]).toMatch(
                /^🔹 #1: .* Finding symbol `MyClass`\.\.\.$/
            );
            expect(calls[1][0]).toMatch(
                /^🔹 #1: .* Finding usages of `login`\.\.\.$/
            );
            expect(calls[2][0]).toMatch(
                /^🔹 #1: .* Searching for `TODO`\.\.\.$/
            );
        });
    });
});
