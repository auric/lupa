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
 * Root-only tools: plan tracking, review submission, and reflection tools
 * that require PR-level context and should never be given to subagents.
 * Shared base for all disallowed-tool lists to prevent drift.
 *
 * NOTE: think_about_investigation is intentionally EXCLUDED from this list.
 * It's the only think tool designed for focused investigations without
 * needing diff context or PR-level review state that subagents don't have.
 */
const ROOT_ONLY_TOOLS = [
    'update_plan',
    'submit_review',
    'think_about_completion',
    'think_about_task',
] as const;

/**
 * Diff tools that require parsedDiff in ExecutionContext.
 */
export const DIFF_TOOLS = ['get_file_diff'] as const;

/**
 * Static limits for subagent execution that don't need user configuration.
 * Dynamic limits (max per session, timeout) come from WorkspaceSettingsService.
 */
export const SubagentLimits = {
    /** Minimum task length to ensure meaningful instructions */
    MIN_TASK_LENGTH: 30,
    /** Tools that subagents cannot access (flat mode — no recursion) */
    DISALLOWED_TOOLS: [
        'run_subagent', // Prevent sub-subagent recursion
        ...ROOT_ONLY_TOOLS,
    ] as const,
} as const;

/**
 * Tools disallowed for recursive child agents.
 * They CAN call run_subagent (enabling recursion) but cannot access
 * plan-tracking and final-review tools that belong to the root agent.
 */
export const RECURSIVE_CHILD_DISALLOWED_TOOLS = [...ROOT_ONLY_TOOLS] as const;

/**
 * Tools that are only available during main analysis mode (not exploration mode).
 * Exploration mode (no slash command) doesn't have PR context or a review plan,
 * so these tools would either fail or return nonsensical guidance.
 */
export const MAIN_ANALYSIS_ONLY_TOOLS = [
    ...ROOT_ONLY_TOOLS,
    ...DIFF_TOOLS,
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

    maxIterations: (toolCallsMade: number, maxIter: number) =>
        `Subagent reached maximum iterations (${maxIter}) after ${toolCallsMade} tool calls. ` +
        `Investigation may be incomplete. Break the task into smaller, more focused subtasks.`,

    rateLimited: (toolCallsMade: number) =>
        `Subagent was rate limited after ${toolCallsMade} tool calls. ` +
        `Wait before spawning more subagents, or use direct tools instead.`,

    failed: (error: string) => `Subagent failed: ${error}`,
} as const;
