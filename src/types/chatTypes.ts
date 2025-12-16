import * as vscode from "vscode";

/**
 * Callback interface for streaming chat responses.
 * Different from ToolCallHandler in conversationRunner.ts which is for conversation recording.
 * This interface is for the chat participant to stream progress and findings.
 */
export interface ChatToolCallHandler {
    /** Called to stream progress updates during analysis */
    onProgress(message: string): void;

    /** Called when a tool starts executing */
    onToolStart(toolName: string, args: Record<string, unknown>): void;

    /** Called when a tool completes */
    onToolComplete(toolName: string, success: boolean, summary: string): void;

    /** Called to reference a file location (creates clickable anchor) */
    onFileReference(filePath: string, range?: vscode.Range): void;

    /** Called to show AI thinking/reasoning */
    onThinking(thought: string): void;

    /** Called to stream markdown content */
    onMarkdown(content: string): void;
}
