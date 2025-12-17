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

/**
 * Represents a single finding (issue or suggestion) in analysis results.
 * Used by ChatResponseBuilder to format finding cards.
 * @see docs/ux-design-specification.md#design-direction-decision
 */
export interface Finding {
    /** Display title for the finding (e.g., "SQL Injection Risk") */
    title: string;
    /** File location display text (e.g., "handler.ts#L45") */
    location: string;
    /** Markdown anchor link (e.g., "src/auth/handler.ts#L45") */
    anchor: string;
    /** Description text explaining the issue and guidance */
    description: string;
}

/**
 * Metadata stored with chat analysis results for follow-up handling and history.
 * Used by ChatParticipantService to track analysis context across conversation turns.
 */
export interface ChatAnalysisMetadata {
    /** The analysis mode that was used */
    mode?: 'branch' | 'changes';
    /** Base branch for comparison (when mode is 'branch') */
    baseBranch?: string;
    /** Target branch being analyzed (when mode is 'branch') */
    targetBranch?: string;
    /** Unix timestamp when analysis was performed */
    analysisTimestamp?: number;
}
