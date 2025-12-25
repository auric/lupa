import * as vscode from "vscode";
import { ChatToolCallHandler } from "../types/chatTypes";

/**
 * Decorator that rate-limits progress updates to prevent UI flicker.
 * Implements NFR-002: max 10 updates/second (100ms minimum interval).
 *
 * Only `onProgress` is debounced. Other events pass through immediately
 * after flushing any pending progress message.
 */
export class DebouncedStreamHandler implements ChatToolCallHandler {
    private lastProgressTime = 0;
    private pendingProgress: string | undefined;
    private readonly minIntervalMs = 100; // 10 updates/sec max

    constructor(private readonly innerHandler: ChatToolCallHandler) { }

    onProgress(message: string): void {
        const now = Date.now();
        if (now - this.lastProgressTime >= this.minIntervalMs) {
            this.innerHandler.onProgress(message);
            this.lastProgressTime = now;
            this.pendingProgress = undefined;
        } else {
            // Store for potential flush - latest message wins
            this.pendingProgress = message;
        }
    }

    onToolStart(toolName: string, args: Record<string, unknown>): void {
        this.flushPending();
        this.innerHandler.onToolStart(toolName, args);
    }

    onToolComplete(toolName: string, success: boolean, summary: string): void {
        this.flushPending();
        this.innerHandler.onToolComplete(toolName, success, summary);
    }

    onFileReference(filePath: string, range?: vscode.Range): void {
        // File references pass through without flush - they don't interrupt flow
        this.innerHandler.onFileReference(filePath, range);
    }

    onThinking(thought: string): void {
        this.flushPending();
        this.innerHandler.onThinking(thought);
    }

    onMarkdown(content: string): void {
        this.flushPending();
        this.innerHandler.onMarkdown(content);
    }

    /**
     * Flush any pending progress message.
     * Call this at the end of analysis to ensure the final message is sent.
     */
    flush(): void {
        this.flushPending();
    }

    private flushPending(): void {
        if (this.pendingProgress) {
            this.innerHandler.onProgress(this.pendingProgress);
            this.pendingProgress = undefined;
            this.lastProgressTime = Date.now();
        }
    }
}
