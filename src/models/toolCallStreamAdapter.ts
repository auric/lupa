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
    constructor(private readonly chatHandler: ChatToolCallHandler) { }

    /**
     * Called when a conversation iteration starts.
     * Forwards to onProgress with turn count and thinking emoji.
     */
    onIterationStart(current: number, max: number): void {
        this.chatHandler.onProgress(
            `Turn ${current}/${max}: ${ACTIVITY.thinking} Analyzing...`
        );
    }

    /**
     * Called when a tool execution starts.
     * Forwards to onToolStart with tool name.
     */
    onToolCallStart(toolName: string, _toolIndex: number, _totalTools: number): void {
        this.chatHandler.onToolStart(toolName, {});
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
        const summary = success ? 'completed' : (error || 'failed');
        this.chatHandler.onToolComplete(toolName, success, summary);
    }
}
