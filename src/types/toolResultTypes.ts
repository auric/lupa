/**
 * Standard result interface for all tool executions.
 * Provides consistent success/failure reporting across all tools.
 */
export interface ToolResult<T = unknown> {
    /** Whether the tool execution achieved its intended goal */
    success: boolean;
    /** The result data when successful */
    data?: T;
    /** Error message when success is false */
    error?: string;
}

/**
 * Type guard to check if a value is a ToolResult object
 */
export function isToolResult(value: unknown): value is ToolResult {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    return 'success' in value && typeof (value as ToolResult).success === 'boolean';
}

/**
 * Helper to create a successful ToolResult
 */
export function toolSuccess<T>(data: T): ToolResult<T> {
    return { success: true, data };
}

/**
 * Helper to create a failed ToolResult
 */
export function toolError(error: string): ToolResult<never> {
    return { success: false, error };
}
