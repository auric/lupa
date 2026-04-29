/**
 * Types for displaying tool call history in the webview
 */

/**
 * Represents a single tool call record for display purposes
 */
export interface ToolCallRecord {
    /** Unique identifier for the tool call */
    id: string;
    /** Name of the tool that was called */
    toolName: string;
    /** Arguments passed to the tool */
    arguments: Record<string, unknown>;
    /** Result returned by the tool (can be string or structured data) */
    result: string | Record<string, unknown>;
    /** Whether the tool execution was successful */
    success: boolean;
    /** Error message if the execution failed */
    error: string | undefined;
    /** Duration of the tool execution in milliseconds */
    durationMs: number | undefined;
    /** Timestamp when the tool was called */
    timestamp: number;
    /** Nested tool calls from subagent (only for run_subagent_batch tool) */
    nestedCalls?: ToolCallRecord[];
    /** Actual wall-clock execution time (only for run_subagent_batch — replaces inaccurate batch-averaged durationMs) */
    executionTimeMs?: number;
    /** Number of LLM iterations (turns) used (only for run_subagent_batch) */
    iterationsUsed?: number;
}

/**
 * Collection of tool calls for an analysis session
 */
export interface ToolCallsData {
    /** Array of tool call records (top-level; nested calls are in ToolCallRecord.nestedCalls) */
    calls: ToolCallRecord[];
    /** Number of top-level tool calls (excludes nested subagent calls) */
    totalCalls: number;
    /** Number of successful top-level tool calls */
    successfulCalls: number;
    /** Number of failed top-level tool calls */
    failedCalls: number;
    /** Whether the analysis was completed or interrupted */
    analysisCompleted: boolean;
    /** Error message if the analysis was interrupted */
    analysisError: string | undefined;
    /** Number of LLM iterations (turns) used by the main analysis */
    iterationsUsed?: number;
    /** Maximum iterations configured for the main analysis */
    maxIterations?: number;
    /** Whether the analysis was truncated due to iteration limits or degraded state */
    wasTruncated: boolean;
}

/**
 * Callback for reporting analysis progress to the UI.
 * @param message - Human-readable status message
 * @param incrementPercent - Optional percentage increment (small values like 0.1-1 work best for smooth progress)
 */
export type AnalysisProgressCallback = (
    message: string,
    incrementPercent?: number
) => void;
