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
 * Limits for subagent execution.
 * Prevents resource exhaustion while allowing meaningful investigations.
 * Note: Tool call limits come from WorkspaceSettingsService, not here.
 */
export const SubagentLimits = {
	/** Maximum subagents that can be spawned per analysis session */
	MAX_PER_SESSION: 5,
	/** Minimum task length to ensure meaningful instructions */
	MIN_TASK_LENGTH: 30,
	/** Timeout for subagent execution in milliseconds */
	TIMEOUT_MS: 120_000,
	/** Tools that subagents cannot access to prevent recursion */
	DISALLOWED_TOOLS: ['run_subagent'] as const,
} as const;

/**
 * Error messages for subagent execution failures.
 * Provides actionable feedback to guide the LLM to improve requests.
 */
export const SubagentErrors = {
	maxExceeded: (max: number) =>
		`Maximum subagents (${max}) reached for this session. Use direct tools for remaining investigations.`,

	taskTooShort: (min: number) =>
		`Task too brief (${min}+ chars needed). Include: WHAT to investigate, WHERE to look, WHAT to return.`,

	timeout: (ms: number) =>
		`Subagent timed out after ${ms / 1000}s. Break into smaller, more focused tasks.`,

	failed: (error: string) =>
		`Subagent failed: ${error}`,
} as const;
