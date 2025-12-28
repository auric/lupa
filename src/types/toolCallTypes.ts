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
    /** Nested tool calls from subagent (only for run_subagent tool) */
    nestedCalls?: ToolCallRecord[];
}

/**
 * Collection of tool calls for an analysis session
 */
export interface ToolCallsData {
    /** Array of tool call records */
    calls: ToolCallRecord[];
    /** Total number of tool calls made */
    totalCalls: number;
    /** Number of successful tool calls */
    successfulCalls: number;
    /** Number of failed tool calls */
    failedCalls: number;
    /** Whether the analysis was completed or interrupted */
    analysisCompleted: boolean;
    /** Error message if the analysis was interrupted */
    analysisError: string | undefined;
}

/**
 * Result from tool-calling analysis including both analysis text and tool call history
 */
export interface ToolCallingAnalysisResult {
    /** The analysis text produced by the LLM */
    analysis: string;
    /** History of tool calls made during analysis */
    toolCalls: ToolCallsData;
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

/**
 * Context provider for subagent progress reporting.
 * Returns the current main analysis iteration info for context-aware messages.
 */
export interface SubagentProgressContext {
    getCurrentIteration: () => number;
    getMaxIterations: () => number;
}
