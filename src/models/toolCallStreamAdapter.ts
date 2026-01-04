import type { ToolCallHandler } from './conversationRunner';
import type { ChatToolCallHandler } from '../types/chatTypes';
import { ACTIVITY } from '../config/chatEmoji';
import type { ToolResultMetadata } from '../types/toolResultTypes';

/**
 * Formatted tool message with optional inline anchor.
 * Unifies text formatting and file path extraction into a single structure.
 */
interface ToolMessage {
    /** Full text for progress display (fallback when no anchor) */
    text: string;
    /** If present, render as markdown with inline clickable anchor */
    anchor?: {
        /** Text before the anchor (e.g., "📂 Reading ") */
        prefix: string;
        /** File path to make clickable */
        path: string;
    };
}

/**
 * Adapts ConversationRunner's ToolCallHandler to ChatToolCallHandler for UI streaming.
 * Bridges internal conversation events to external chat UI updates.
 *
 * Architecture:
 * - Uses ToolMessage to unify formatting and file extraction
 * - File-based tools render as markdown with inline clickable anchors
 * - Other tools render as transient progress messages
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
     * Emits either markdown with inline anchor (file tools) or progress message.
     */
    onToolCallStart(
        toolName: string,
        args: Record<string, unknown>,
        _toolIndex: number,
        _totalTools: number
    ): void {
        this.chatHandler.onToolStart(toolName, args);

        const msg = this.formatToolMessage(toolName, args);

        if (msg.anchor) {
            // File-based tool: emit markdown with inline anchor
            this.chatHandler.onMarkdown(msg.anchor.prefix);
            this.chatHandler.onFileReference(msg.anchor.path);
            this.chatHandler.onMarkdown('\n\n');
        } else {
            // Non-file tool: emit transient progress
            this.chatHandler.onProgress(msg.text);
        }
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
     * Formats a tool invocation into a displayable message.
     * Returns structured data with optional anchor for file-based tools.
     */
    private formatToolMessage(
        toolName: string,
        args: Record<string, unknown>
    ): ToolMessage {
        switch (toolName) {
            // File-based tools: return anchor info for clickable paths
            case 'read_file': {
                const path = args.file_path as string | undefined;
                if (path) {
                    return {
                        text: `${ACTIVITY.reading} Reading ${path}`,
                        anchor: {
                            prefix: `${ACTIVITY.reading} Reading `,
                            path,
                        },
                    };
                }
                return { text: `${ACTIVITY.reading} Reading file...` };
            }

            case 'list_directory': {
                const path = args.relative_path as string | undefined;
                if (path) {
                    return {
                        text: `${ACTIVITY.reading} Listing ${path}`,
                        anchor: {
                            prefix: `${ACTIVITY.reading} Listing `,
                            path,
                        },
                    };
                }
                return { text: `${ACTIVITY.reading} Listing directory...` };
            }

            case 'get_symbols_overview': {
                const path = args.path as string | undefined;
                if (path) {
                    return {
                        text: `${ACTIVITY.analyzing} Getting symbols in ${path}`,
                        anchor: {
                            prefix: `${ACTIVITY.analyzing} Getting symbols in `,
                            path,
                        },
                    };
                }
                return { text: `${ACTIVITY.analyzing} Getting symbols...` };
            }

            // Non-file tools: return text only
            case 'update_plan':
                return { text: '📝 Updating analysis plan...' };

            case 'find_symbol':
                return {
                    text: `${ACTIVITY.searching} Finding symbol \`${args.name_path || 'symbol'}\`...`,
                };

            case 'find_usages':
                return {
                    text: `${ACTIVITY.analyzing} Finding usages of \`${args.symbol_name || 'symbol'}\`...`,
                };

            case 'find_files_by_pattern':
                return {
                    text: `${ACTIVITY.searching} Finding files matching \`${args.pattern || 'pattern'}\`...`,
                };

            case 'search_for_pattern':
                return {
                    text: `${ACTIVITY.searching} Searching for \`${args.pattern || 'pattern'}\`...`,
                };

            case 'run_subagent':
                return { text: '🤖 Spawning subagent investigation...' };

            case 'think_about_context':
                return { text: '🧠 Reflecting on context...' };

            case 'think_about_investigation':
                return { text: '🧠 Checking investigation progress...' };

            case 'think_about_task':
                return { text: '🧠 Verifying task alignment...' };

            case 'think_about_completion':
                return { text: '🧠 Verifying analysis completeness...' };

            case 'submit_review':
                return { text: '🚀 Submitting code review...' };

            default:
                return { text: `🔧 Running ${toolName}...` };
        }
    }
}
