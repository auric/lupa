import type { ToolCallHandler } from './conversationRunner';
import type { ChatToolCallHandler } from '../types/chatTypes';
import type { ToolResultMetadata } from '../types/toolResultTypes';
import { ToolCallStreamAdapter } from './toolCallStreamAdapter';

/**
 * Adapts tool call events for subagent context with visual distinction.
 * Wraps a ChatToolCallHandler and prefixes progress/thinking messages with subagent indicator.
 *
 * UX Design:
 * - Main agent: "📂 Reading src/index.ts..."
 * - Subagent:   "🔹 #1: 📂 Reading src/auth.ts..."
 *
 * This provides clear visual distinction between main and subagent work.
 */
export class SubagentStreamAdapter implements ToolCallHandler {
    private readonly innerAdapter: ToolCallStreamAdapter;
    private readonly prefix: string;

    /**
     * @param chatHandler The base chat handler to wrap
     * @param subagentId The unique subagent identifier (1, 2, 3...)
     */
    constructor(
        chatHandler: ChatToolCallHandler,
        private readonly subagentId: number
    ) {
        this.prefix = `🔹 #${subagentId}: `;
        this.innerAdapter = new ToolCallStreamAdapter(
            this.createPrefixedHandler(chatHandler)
        );
    }

    /**
     * Creates a wrapped ChatToolCallHandler that prefixes progress and thinking messages.
     * Simple pass-through for other methods.
     */
    private createPrefixedHandler(
        baseHandler: ChatToolCallHandler
    ): ChatToolCallHandler {
        return {
            onProgress: (msg) => baseHandler.onProgress(`${this.prefix}${msg}`),
            onThinking: (thought) =>
                baseHandler.onThinking(`${this.prefix}${thought}`),
            // Pass-through methods (no prefixing needed)
            onToolStart: baseHandler.onToolStart.bind(baseHandler),
            onToolComplete: baseHandler.onToolComplete.bind(baseHandler),
            onFileReference: baseHandler.onFileReference.bind(baseHandler),
            onMarkdown: baseHandler.onMarkdown.bind(baseHandler),
        };
    }

    // Delegate all ToolCallHandler methods to the inner adapter

    onIterationStart(_current: number, _max: number): void {
        // Suppress iteration messages for subagents - just show tool actions
    }

    onToolCallStart(
        toolName: string,
        args: Record<string, unknown>,
        toolIndex: number,
        totalTools: number
    ): void {
        this.innerAdapter.onToolCallStart(
            toolName,
            args,
            toolIndex,
            totalTools
        );
    }

    onToolCallComplete(
        toolCallId: string,
        toolName: string,
        args: Record<string, unknown>,
        result: string,
        success: boolean,
        error?: string,
        durationMs?: number,
        metadata?: ToolResultMetadata
    ): void {
        this.innerAdapter.onToolCallComplete(
            toolCallId,
            toolName,
            args,
            result,
            success,
            error,
            durationMs,
            metadata
        );
    }
}
