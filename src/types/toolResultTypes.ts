import type { ToolCallRecord } from './toolCallTypes';

/**
 * Standard result interface for all tool executions.
 * Provides consistent success/failure reporting across all tools.
 * Data is always string since LLM tool responses are text-based.
 */
export interface ToolResult {
    /** Whether the tool execution achieved its intended goal */
    success: boolean;
    /** The result data when successful */
    data?: string;
    /** Error message when success is false */
    error?: string;
    /** Optional metadata for complex tool results (e.g., subagent nested tool calls) */
    metadata?: ToolResultMetadata;
}

/**
 * Metadata for complex tool results
 */
export interface ToolResultMetadata {
    /** Nested tool calls from subagent execution (reuses ToolCallRecord for consistency) */
    nestedToolCalls?: ToolCallRecord[];
    /** Whether this tool signals completion (used by submit_review) */
    isCompletion?: boolean;
    /** Actual wall-clock execution time for subagent tool calls */
    executionTimeMs?: number;
    /** Number of LLM iterations (turns) used by a subagent */
    iterationsUsed?: number;
}

/**
 * Helper to create a successful ToolResult
 */
export function toolSuccess(
    data: string,
    metadata?: ToolResultMetadata
): ToolResult {
    return metadata
        ? { success: true, data, metadata }
        : { success: true, data };
}

/**
 * Helper to create a failed ToolResult
 */
export function toolError(error: string): ToolResult {
    return { success: false, error };
}
