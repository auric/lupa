import type { ToolCallHandler } from './conversationRunner';
import type { ChatToolCallHandler } from '../types/chatTypes';
import { ACTIVITY } from '../config/chatEmoji';
import type { ToolResultMetadata } from '../types/toolResultTypes';

/**
 * Adapts ConversationRunner's ToolCallHandler to ChatToolCallHandler for UI streaming.
 * Bridges internal conversation events to external chat UI updates.
 *
 * Architecture:
 * - Uses stream.progress() for all tool feedback (transient, clears on completion)
 * - formatToolMessage() returns plain strings for simplicity
 * - No anchors/markdown - progress messages provide clean UX that clears for final output
 *
 * @see docs/architecture.md - Architecture Decision 10: Streaming Debounce Pattern
 */
export class ToolCallStreamAdapter implements ToolCallHandler {
    constructor(private readonly chatHandler: ChatToolCallHandler) {}

    /**
     * Called when a conversation iteration starts.
     * No-op: turn indicators are noise. Users care about tool actions.
     */
    onIterationStart(_current: number, _max: number): void {}

    /**
     * Called when a tool execution starts.
     * Emits transient progress message showing current tool activity.
     */
    onToolCallStart(
        toolName: string,
        args: Record<string, unknown>,
        _toolIndex: number,
        _totalTools: number
    ): void {
        this.chatHandler.onToolStart(toolName, args);
        this.chatHandler.onProgress(this.formatToolMessage(toolName, args));
    }

    /**
     * Called after each tool call completes.
     */
    onToolCallComplete(
        _toolCallId: string,
        toolName: string,
        _args: Record<string, unknown>,
        _result: string,
        success: boolean,
        error?: string,
        _durationMs?: number,
        _metadata?: ToolResultMetadata
    ): void {
        const summary = success ? 'completed' : error || 'failed';
        this.chatHandler.onToolComplete(toolName, success, summary);
    }

    /**
     * Formats a tool invocation into a displayable progress message.
     * - Quick actions (file reads, searches): Past tense - completed by render time
     * - Long-running actions (thinking, subagents): Present continuous - still in progress
     */
    private formatToolMessage(
        toolName: string,
        args: Record<string, unknown>
    ): string {
        switch (toolName) {
            // Quick actions - past tense
            case 'read_file':
                return `${ACTIVITY.reading} Read ${args.file_path || 'file'}`;

            case 'list_directory':
                return `${ACTIVITY.reading} Listed ${args.relative_path || 'directory'}`;

            case 'get_symbols_overview':
                return `${ACTIVITY.analyzing} Analyzed symbols in ${args.path || 'file'}`;

            case 'update_plan':
                return '📝 Updated analysis plan';

            case 'find_symbol':
                return `${ACTIVITY.searching} Found symbol \`${args.name_path || 'symbol'}\``;

            case 'find_usages': {
                const symbol = args.symbol_name || 'symbol';
                const file = args.file_path ? ` in ${args.file_path}` : '';
                return `${ACTIVITY.analyzing} Found usages of \`${symbol}\`${file}`;
            }

            case 'find_files_by_pattern':
                return `${ACTIVITY.searching} Found files matching \`${args.pattern || 'pattern'}\``;

            case 'search_for_pattern':
                return `${ACTIVITY.searching} Searched for \`${args.pattern || 'pattern'}\``;

            case 'submit_review':
                return '🚀 Submitted code review';

            // Long-running actions - present continuous
            case 'run_subagent':
                return '🤖 Running subagent investigation...';

            case 'think_about_context':
                return '🧠 Analyzing context...';

            case 'think_about_investigation':
                return '🧠 Reviewing investigation progress...';

            case 'think_about_task':
                return '🧠 Verifying task alignment...';

            case 'think_about_completion':
                return '🧠 Verifying analysis completeness...';

            default:
                return `🔧 Executed ${toolName}`;
        }
    }
}
