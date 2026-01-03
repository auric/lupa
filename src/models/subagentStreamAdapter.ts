import type { ToolCallHandler } from './conversationRunner';
import type { ChatToolCallHandler } from '../types/chatTypes';
import type { ToolResultMetadata } from '../types/toolResultTypes';
import { ToolCallStreamAdapter } from './toolCallStreamAdapter';

/**
 * Adapts tool call events for subagent context with visual distinction.
 * Wraps a ChatToolCallHandler and prefixes all messages with the subagent indicator.
 *
 * UX Design:
 * - Main agent: "📂 Reading src/index.ts..."
 * - Subagent:   "🔹 #1: Reading src/auth.ts..."
 *
 * This provides clear visual distinction between main and subagent work
 * while maintaining clickable file references.
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
        // Create a prefixed wrapper that adds subagent indicator to all messages
        this.prefix = `🔹 #${subagentId}: `;
        this.innerAdapter = new ToolCallStreamAdapter(
            this.createPrefixedHandler(chatHandler)
        );
    }

    /**
     * Creates a wrapped ChatToolCallHandler that prefixes progress and markdown messages.
     * For file-based tools, the prefix is added to markdown content (the first fragment).
     * For other tools, the prefix is added to progress messages.
     */
    private createPrefixedHandler(
        baseHandler: ChatToolCallHandler
    ): ChatToolCallHandler {
        return {
            onProgress: (msg) => {
                // Prefix progress messages with subagent indicator
                baseHandler.onProgress(`${this.prefix}${msg}`);
            },
            onToolStart: baseHandler.onToolStart.bind(baseHandler),
            onToolComplete: baseHandler.onToolComplete.bind(baseHandler),
            onFileReference: baseHandler.onFileReference.bind(baseHandler),
            onThinking: (thought) => {
                // Prefix thinking messages too
                baseHandler.onThinking(`${this.prefix}${thought}`);
            },
            onMarkdown: (content) => {
                // Prefix markdown messages that start with an emoji (tool message start)
                // Don't prefix suffix fragments like "...\n\n"
                if (this.isToolMessageStart(content)) {
                    baseHandler.onMarkdown(`${this.prefix}${content}`);
                } else {
                    baseHandler.onMarkdown(content);
                }
            },
        };
    }

    /**
     * Checks if content is the start of a tool message (begins with emoji).
     * Used to determine when to add the subagent prefix.
     */
    private isToolMessageStart(content: string): boolean {
        // Tool messages start with emoji like 📂, 🔍, etc.
        // The suffix ("...\n\n") doesn't start with emoji
        const emojiPattern = /^[\p{Emoji_Presentation}\p{Emoji}\u{FE0F}]/u;
        return emojiPattern.test(content);
    }

    // Delegate all ToolCallHandler methods to the inner adapter

    onIterationStart(_current: number, _max: number): void {
        // Suppress iteration messages for subagents - just show tool actions
        // This avoids the noisy "Sub-analysis (1/100)..." messages
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
