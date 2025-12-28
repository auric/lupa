import type { ToolCallHandler } from './conversationRunner';
import type { ChatToolCallHandler } from '../types/chatTypes';
import { ACTIVITY } from '../config/chatEmoji';
import type { ToolResultMetadata } from '../types/toolResultTypes';

/**
 * Adapts ConversationRunner's ToolCallHandler to ChatToolCallHandler for UI streaming.
 * Bridges the internal conversation events to external chat UI updates.
 *
 * Part of the Three-Layer Streaming Architecture:
 * 1. UI Handler (ChatToolCallHandler) → stream.* calls
 * 2. DebouncedStreamHandler → rate limiting (NFR-002)
 * 3. ToolCallStreamAdapter (this class) → interface bridge
 *
 * @see docs/architecture.md - Architecture Decision 10: Streaming Debounce Pattern
 */
export class ToolCallStreamAdapter implements ToolCallHandler {
    constructor(private readonly chatHandler: ChatToolCallHandler) {}

    /**
     * Called when a conversation iteration starts.
     * Intentionally does NOT show turn indicators - they're noise.
     * Users care about tool actions, not iteration counts.
     */
    onIterationStart(_current: number, _max: number): void {
        // No-op: Turn indicators removed per UX decision.
        // Tool-specific messages provide sufficient progress feedback.
    }

    /**
     * Called when a tool execution starts.
     * Forwards formatted progress message based on tool type and args.
     */
    onToolCallStart(
        toolName: string,
        args: Record<string, unknown>,
        _toolIndex: number,
        _totalTools: number
    ): void {
        const message = this.formatToolStartMessage(toolName, args);
        this.chatHandler.onProgress(message);
        this.chatHandler.onToolStart(toolName, args);
    }

    /**
     * Called after each tool call completes.
     * Forwards to onToolComplete with success/failure summary.
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
     * Formats a human-readable progress message for tool execution.
     * Uses tool-specific templates with argument interpolation.
     */
    private formatToolStartMessage(
        toolName: string,
        args: Record<string, unknown>
    ): string {
        switch (toolName) {
            case 'read_file':
                return `${ACTIVITY.reading} Reading ${args.file_path || 'file'}...`;

            case 'find_symbol':
                return `${ACTIVITY.searching} Finding symbol \`${args.name_path || 'symbol'}\`...`;

            case 'find_usages':
                return `${ACTIVITY.analyzing} Finding usages of \`${args.symbol_name || 'symbol'}\`...`;

            case 'list_directory':
                return `${ACTIVITY.reading} Listing ${args.path || 'directory'}...`;

            case 'find_files_by_pattern':
                return `${ACTIVITY.searching} Finding files matching \`${args.pattern || 'pattern'}\`...`;

            case 'get_symbols_overview':
                return `${ACTIVITY.analyzing} Getting symbols in ${args.path || 'file'}...`;

            case 'search_for_pattern':
                return `${ACTIVITY.searching} Searching for \`${args.pattern || 'pattern'}\`...`;

            case 'run_subagent':
                return `🤖 Spawning subagent investigation...`;

            case 'think_about_context':
                return `🧠 Reflecting on context...`;

            case 'think_about_investigation':
                return `🧠 Checking investigation progress...`;

            case 'think_about_task':
                return `🧠 Verifying task alignment...`;

            case 'think_about_completion':
                return `🧠 Verifying analysis completeness...`;

            default:
                return `🔧 Running ${toolName}...`;
        }
    }
}
