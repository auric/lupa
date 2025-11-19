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
