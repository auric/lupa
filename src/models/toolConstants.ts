/**
 * Constants for tool execution and behavior
 *
 * Centralized location for tool-specific configuration values to avoid magic numbers
 * and enable consistent behavior across all tools.
 */
export class ToolConstants {
    /**
     * Maximum number of tool calls allowed per analysis session.
     * Prevents runaway tool calling loops and excessive API usage.
     * Counter resets when a new ToolExecutor instance is created (per analysis session).
     */
    static readonly MAX_TOOL_CALLS_PER_SESSION = 50;

    /**
     * Default maximum number of symbols to return from FindSymbolTool.
     * Balances comprehensive results with token budget constraints.
     */
    static readonly DEFAULT_MAX_SYMBOL_RESULTS = 20;

    /**
     * Hard limit for max_results parameter in FindSymbolTool.
     * Prevents overwhelming the context window with too many results.
     */
    static readonly MAX_SYMBOL_RESULTS_LIMIT = 200;

    /**
     * Error messages for tool execution failures.
     * Provides clear, actionable feedback to the LLM.
     */
    static readonly ERROR_MESSAGES = {
        RATE_LIMIT_EXCEEDED: (max: number, current: number) =>
            `Rate limit exceeded: ${current} tool calls made, maximum ${max} per analysis session. Please refine your analysis approach.`,
    } as const;
}

/**
 * Static limits for subagent execution that don't need user configuration.
 * Dynamic limits (max per session, timeout) come from WorkspaceSettingsService.
 */
export const SubagentLimits = {
    /** Minimum task length to ensure meaningful instructions */
    MIN_TASK_LENGTH: 30,
    /** Tools that subagents cannot access */
    DISALLOWED_TOOLS: [
        'run_subagent', // Prevent sub-subagent recursion
        'update_plan', // Main agent only - subagents don't track review progress
        'submit_review', // Main agent only - explicit completion signal
        'think_about_completion', // Main agent only - for final review verification
        'think_about_context', // Main agent only - references diff coverage
        'think_about_task', // Main agent only - references PR review scope
        // NOTE: think_about_investigation is intentionally ALLOWED for subagents.
        // It's the only think tool designed for focused investigations without
        // needing diff context or PR-level review state that subagents don't have.
    ] as const,
} as const;

/**
 * Tools that are only available during main analysis mode (not exploration mode).
 * Exploration mode (no slash command) doesn't have PR context or a review plan,
 * so these tools would either fail or return nonsensical guidance.
 */
export const MAIN_ANALYSIS_ONLY_TOOLS = [
    'update_plan', // Requires planManager from ExecutionContext
    'submit_review', // Semantically for completing PR analysis
    'think_about_completion', // References PR analysis completion criteria
    'think_about_context', // References diff coverage and PR-level context
    'think_about_task', // References PR review scope and task structure
] as const;

/**
 * Error messages for subagent execution failures.
 */
export const SubagentErrors = {
    maxExceeded: (max: number) =>
        `Maximum subagents (${max}) reached for this session. Use direct tools for remaining investigations.`,

    taskTooShort: (min: number) =>
        `Task too brief (${min}+ chars needed). Include: WHAT to investigate, WHERE to look, WHAT to return.`,

    timeout: (ms: number) =>
        `Subagent timed out after ${ms / 1000}s. Break into smaller, more focused tasks.`,

    maxIterations: (toolCalls: number, maxIter: number) =>
        `Subagent reached maximum iterations (${maxIter}) after ${toolCalls} tool calls. ` +
        `Investigation may be incomplete. Break the task into smaller, more focused subtasks.`,

    failed: (error: string) => `Subagent failed: ${error}`,
} as const;
